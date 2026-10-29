import { DatabaseSync } from 'node:sqlite';
import { cosineSimilarity } from './embed.js';
import type { NovelChunk } from './chunker.js';

/**
 * 向量存储（v3a MVP）：SQLite 存向量 JSON，查询时全量暴力余弦检索。
 *
 * 为什么不先上 pgvector：一本小说几百个块，暴力检索毫秒级，引入向量库是过度设计。
 * 等块数上万、暴力检索成为瓶颈时再迁——届时只改这个文件，上层无感。
 * 这个"什么时候才需要向量数据库"的判断本身就是面试考点。
 */

// 与 db.ts 相同的 data/ 目录（Docker 数据卷挂载点）
import { mkdirSync } from 'node:fs';
mkdirSync('data', { recursive: true });
const db = new DatabaseSync('data/data.db');
db.exec(`
  CREATE TABLE IF NOT EXISTS novels (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    owner TEXT NOT NULL DEFAULT 'admin',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS chunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    novel_id TEXT NOT NULL REFERENCES novels(id),
    chapter TEXT NOT NULL,
    idx INTEGER NOT NULL,
    text TEXT NOT NULL,
    vector TEXT NOT NULL
  );
`);
// 老库补列 + 演示库标记：游客只能检索 owner='public' 的小说
function addColumnIfMissing(table: string, column: string, def: string) {
  const cols = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
}
addColumnIfMissing('novels', 'owner', "TEXT NOT NULL DEFAULT 'admin'");
addColumnIfMissing('novels', 'meta', 'TEXT');
db.exec(`UPDATE novels SET owner = 'public' WHERE title = '雪夜来客'`);

export function createNovel(title: string, owner = 'admin'): string {
  const id = crypto.randomUUID();
  db.prepare('INSERT INTO novels (id, title, owner) VALUES (?, ?, ?)').run(id, title, owner);
  return id;
}

/** 游客只见公开演示库；管理员见全部（meta 为 JSON 字符串，调用方自行解析） */
export function listNovels(viewer: 'admin' | 'guest'): { id: string; title: string; owner: string; chunkCount: number; meta: string | null }[] {
  const where = viewer === 'guest' ? "WHERE n.owner = 'public'" : '';
  return db.prepare(`
    SELECT n.id, n.title, n.owner, n.meta, COUNT(c.id) as chunkCount
    FROM novels n LEFT JOIN chunks c ON c.novel_id = n.id
    ${where}
    GROUP BY n.id ORDER BY n.created_at DESC
  `).all() as any;
}

/** 小说结构元数据（入库时统计）：章节全局计数、章节列表、字数 */
export interface NovelMeta {
  totalChapters: number;
  totalChunks: number;
  totalChars: number;
  /** 章节列表：[{ 全局序号, 原文标注, 卷 }] */
  chapterList: { no: number; label: string; volume?: string }[];
}

export function updateNovelMeta(novelId: string, meta: NovelMeta): void {
  db.prepare('UPDATE novels SET meta = ? WHERE id = ?').run(JSON.stringify(meta), novelId);
}

export function getNovelMeta(novelId: string): NovelMeta | undefined {
  const row = db.prepare('SELECT meta FROM novels WHERE id = ?').get(novelId) as { meta: string | null } | undefined;
  return row?.meta ? JSON.parse(row.meta) : undefined;
}

/** 从切块结果直接生成并保存 meta（入库管道两条路径共用：CLI / Web 异步） */
export function saveNovelMetaFromChunks(novelId: string, chunks: NovelChunk[]): void {
  const seen = new Map<number, { no: number; label: string; volume?: string }>();
  let totalChars = 0;
  for (const c of chunks) {
    totalChars += c.text.length;
    if (!seen.has(c.globalChapter)) seen.set(c.globalChapter, { no: c.globalChapter, label: c.chapterLabel, volume: c.volumeLabel });
  }
  updateNovelMeta(novelId, {
    totalChapters: seen.size,
    totalChunks: chunks.length,
    totalChars,
    chapterList: [...seen.values()].sort((a, b) => a.no - b.no),
  });
}

/**
 * 自愈：从库中已存的块反推 meta（老版本入库的数据没有 meta，无需重新向量化）。
 * 全局章序号按「chapter 标签切换次数」推算——与切块时的全局计数一致。
 */
export function backfillNovelMeta(novelId: string): boolean {
  const rows = db.prepare('SELECT chapter, text FROM chunks WHERE novel_id = ? ORDER BY idx').all(novelId) as
    | { chapter: string; text: string }[]
    | undefined;
  if (!rows || rows.length === 0) return false;

  const chapterList: { no: number; label: string }[] = [];
  let totalChars = 0;
  let lastLabel: string | null = null;
  for (const r of rows) {
    totalChars += r.text.length;
    if (r.chapter !== lastLabel) {
      chapterList.push({ no: chapterList.length + 1, label: r.chapter });
      lastLabel = r.chapter;
    }
  }
  updateNovelMeta(novelId, {
    totalChapters: chapterList.length,
    totalChunks: rows.length,
    totalChars,
    chapterList,
  });
  return true;
}

/** 找出缺失 meta 的小说并逐个回填（服务启动时自愈） */
export function backfillAllMissingMeta(): number {
  const rows = db.prepare('SELECT id, title FROM novels WHERE meta IS NULL').all() as { id: string; title: string }[];
  let n = 0;
  for (const r of rows) {
    if (backfillNovelMeta(r.id)) {
      console.log(`[meta] 已回填《${r.title}》的结构元数据`);
      n++;
    }
  }
  return n;
}

export function deleteNovel(novelId: string): boolean {
  db.prepare('DELETE FROM chunks WHERE novel_id = ?').run(novelId);
  const result = db.prepare('DELETE FROM novels WHERE id = ?').run(novelId);
  return result.changes > 0;
}

export function insertChunks(novelId: string, chunks: (NovelChunk & { vector: number[] })[]) {
  const stmt = db.prepare('INSERT INTO chunks (novel_id, chapter, idx, text, vector) VALUES (?, ?, ?, ?, ?)');
  // node:sqlite 没有 better-sqlite3 的 .transaction()，手动控制事务
  db.exec('BEGIN');
  try {
    for (const c of chunks) stmt.run(novelId, c.chapterLabel, c.index, c.text, JSON.stringify(c.vector));
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export function getNovelByTitle(title: string): { id: string; title: string; owner: string } | undefined {
  return db.prepare('SELECT id, title, owner FROM novels WHERE title = ?').get(title) as
    | { id: string; title: string; owner: string }
    | undefined;
}

export interface RetrievedChunk {
  novelTitle?: string;
  chapter: string;
  text: string;
  similarity: number;
}

/** 语义检索：余弦相似度暴力扫描，返回 topK；可按小说过滤；publicOnly 时只扫公开演示库 */
export function searchNovelChunks(queryVector: number[], topK = 3, novelId?: string, publicOnly?: boolean): RetrievedChunk[] {
  const publicFilter = publicOnly ? "AND n.owner = 'public'" : '';
  const rows = (
    novelId
      ? db.prepare(`SELECT c.chapter, c.text, c.vector, n.title as novelTitle FROM chunks c JOIN novels n ON n.id = c.novel_id WHERE c.novel_id = ? ${publicFilter}`).all(novelId)
      : db.prepare(`SELECT c.chapter, c.text, c.vector, n.title as novelTitle FROM chunks c JOIN novels n ON n.id = c.novel_id WHERE 1=1 ${publicFilter}`).all()
  ) as { chapter: string; text: string; vector: string; novelTitle: string }[];
  return rows
    .map((r) => ({
      novelTitle: r.novelTitle,
      chapter: r.chapter,
      text: r.text,
      similarity: cosineSimilarity(queryVector, JSON.parse(r.vector)),
    }))
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, topK);
}
