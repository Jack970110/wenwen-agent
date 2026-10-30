import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { cosineSimilarity } from './embed.js';
import type { NovelChunk } from './chunker.js';
import { determineTier, type Tier } from './tier.js';
import { logger } from '../logger.js';

/**
 * 向量存储（v3a MVP）：SQLite 存向量 JSON，查询时全量暴力余弦检索。
 *
 * 为什么不先上 pgvector：一本小说几百个块，暴力检索毫秒级，引入向量库是过度设计。
 * 等块数上万、暴力检索成为瓶颈时再迁——届时只改这个文件，上层无感。
 * 这个"什么时候才需要向量数据库"的判断本身就是面试考点。
 */

// 与 db.ts 相同的 data/ 目录（Docker 数据卷挂载点）
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
addColumnIfMissing('novels', 'full_text', 'TEXT'); // 仅 T1 微型书使用：整本原文（全量塞上下文用）
// 入库状态：ready 可用 / ingesting 异步入库进行中（列表显示"入库中"，向量化完成才对外可见完整数据）
addColumnIfMissing('novels', 'status', "TEXT NOT NULL DEFAULT 'ready'");
// 内容指纹（SHA-256）：防手滑重复上传——两个 30 分钟的入库任务纯属浪费
addColumnIfMissing('novels', 'content_hash', 'TEXT');
// 全书梗概（不向量化）：全书级问题（"讲了什么故事"）的答案锚点，聚焦该小说时注入提示词。
// 不入库 chunks 的原因：它不是检索目标而是"背景知识"，且向量化后会被海量原文块淹没——
// 顶层摘要走注入，局部问题走向量检索，各走各的路。
addColumnIfMissing('novels', 'book_summary', 'TEXT');
// 多级节点：0 = 原文块 / 1 = 章摘要 / 2 = 段落摘要（T3/T4 摘要层）
addColumnIfMissing('chunks', 'level', 'INTEGER NOT NULL DEFAULT 0');
db.exec(`UPDATE novels SET owner = 'public' WHERE title = '雪夜来客'`);

export function createNovel(title: string, owner = 'admin', fullText?: string, contentHash?: string): string {
  const id = crypto.randomUUID();
  db.prepare('INSERT INTO novels (id, title, owner, full_text, content_hash) VALUES (?, ?, ?, ?, ?)').run(id, title, owner, fullText ?? null, contentHash ?? null);
  return id;
}

/** 内容指纹：同一文件重复上传时秒判（避免排队跑两遍几十分钟的入库任务） */
export function contentHash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function findNovelByContentHash(hash: string): { id: string; title: string } | undefined {
  return db.prepare('SELECT id, title FROM novels WHERE content_hash = ? LIMIT 1').get(hash) as { id: string; title: string } | undefined;
}

/** 入库状态流转：ingesting（向量化中）→ ready；失败走 deleteNovel 回滚，无 error 态残留 */
export function setNovelStatus(novelId: string, status: 'ingesting' | 'ready'): void {
  db.prepare('UPDATE novels SET status = ? WHERE id = ?').run(status, novelId);
}

/**
 * 清理僵尸任务：进程内任务队列随重启丢失，卡在 ingesting 的小说是半截数据
 * （正常失败路径会回滚删除，走到这里说明进程被杀了）。启动时清掉，重传即可。
 */
export function deleteStaleIngestNovels(): number {
  const rows = db.prepare("SELECT id FROM novels WHERE status = 'ingesting'").all() as { id: string }[];
  for (const r of rows) deleteNovel(r.id);
  return rows.length;
}

/** 游客只见公开演示库；管理员见全部（meta 为 JSON 字符串，调用方自行解析） */
export function listNovels(viewer: 'admin' | 'guest'): { id: string; title: string; owner: string; status: string; chunkCount: number; meta: string | null }[] {
  const where = viewer === 'guest' ? "WHERE n.owner = 'public'" : '';
  return db.prepare(`
    SELECT n.id, n.title, n.owner, n.status, n.meta, COUNT(c.id) as chunkCount
    FROM novels n LEFT JOIN chunks c ON c.novel_id = n.id
    ${where}
    GROUP BY n.id ORDER BY n.created_at DESC
  `).all() as any;
}

/** 小说结构元数据（入库时统计）：章节全局计数、章节列表、字数 */
export interface NovelMeta {
  tier: Tier;
  totalChapters: number;
  totalChunks: number;
  totalChars: number;
  /** 文本结构：chapter = 章节序（默认）；section = 无章节结构、按段落切分（文档类） */
  structureType?: 'chapter' | 'section';
  /** 章节列表：[{ 全局序号, 原文标注, 卷 }] */
  chapterList: { no: number; label: string; volume?: string }[];
}

/** 从章节标签判断结构类型：全部是「第N段」格式的为段落模式（切块器自动降级的产物） */
function detectStructureType(labels: string[]): 'chapter' | 'section' {
  return labels.length > 0 && labels.every((l) => /^第\d+段$/.test(l)) ? 'section' : 'chapter';
}

export function updateNovelMeta(novelId: string, meta: NovelMeta): void {
  db.prepare('UPDATE novels SET meta = ? WHERE id = ?').run(JSON.stringify(meta), novelId);
}

export function getNovelMeta(novelId: string): NovelMeta | undefined {
  const row = db.prepare('SELECT meta FROM novels WHERE id = ?').get(novelId) as { meta: string | null } | undefined;
  return row?.meta ? JSON.parse(row.meta) : undefined;
}

/** T1 微型书：整本原文（全量塞上下文用） */
export function getNovelFullText(novelId: string): string | null {
  const row = db.prepare('SELECT full_text FROM novels WHERE id = ?').get(novelId) as { full_text: string | null } | undefined;
  return row?.full_text ?? null;
}

/** 全书梗概（摘要层构建时生成，聚焦时注入提示词） */
export function setNovelBookSummary(novelId: string, summary: string): void {
  db.prepare('UPDATE novels SET book_summary = ? WHERE id = ?').run(summary, novelId);
}

export function getNovelBookSummary(novelId: string): string | null {
  const row = db.prepare('SELECT book_summary FROM novels WHERE id = ?').get(novelId) as { book_summary: string | null } | undefined;
  return row?.book_summary ?? null;
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
    tier: determineTier(totalChars),
    totalChapters: seen.size,
    totalChunks: chunks.length,
    totalChars,
    structureType: detectStructureType([...seen.values()].map((c) => c.label)),
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
    tier: determineTier(totalChars),
    totalChapters: chapterList.length,
    totalChunks: rows.length,
    totalChars,
    structureType: detectStructureType(chapterList.map((c) => c.label)),
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
      logger.info({ novel: r.title }, '结构元数据自愈回填');
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

export function insertChunks(novelId: string, chunks: (NovelChunk & { vector: number[] })[], level = 0) {
  const stmt = db.prepare('INSERT INTO chunks (novel_id, chapter, idx, text, vector, level) VALUES (?, ?, ?, ?, ?, ?)');
  // node:sqlite 没有 better-sqlite3 的 .transaction()，手动控制事务
  db.exec('BEGIN');
  try {
    for (const c of chunks) stmt.run(novelId, c.chapterLabel, c.index, c.text, JSON.stringify(c.vector), level);
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
  level: number;
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
      ? db.prepare(`SELECT c.level, c.chapter, c.text, c.vector, n.title as novelTitle FROM chunks c JOIN novels n ON n.id = c.novel_id WHERE c.novel_id = ? ${publicFilter}`).all(novelId)
      : db.prepare(`SELECT c.level, c.chapter, c.text, c.vector, n.title as novelTitle FROM chunks c JOIN novels n ON n.id = c.novel_id WHERE 1=1 ${publicFilter}`).all()
  ) as { level: number; chapter: string; text: string; vector: string; novelTitle: string }[];
  return rows
    .map((r) => ({
      level: r.level,
      novelTitle: r.novelTitle,
      chapter: r.chapter,
      text: r.text,
      similarity: cosineSimilarity(queryVector, JSON.parse(r.vector)),
    }))
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, topK);
}
