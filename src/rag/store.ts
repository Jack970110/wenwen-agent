import { DatabaseSync } from 'node:sqlite';
import { cosineSimilarity } from './embed.js';

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
db.exec(`UPDATE novels SET owner = 'public' WHERE title = '雪夜来客'`);

export function createNovel(title: string, owner = 'admin'): string {
  const id = crypto.randomUUID();
  db.prepare('INSERT INTO novels (id, title, owner) VALUES (?, ?, ?)').run(id, title, owner);
  return id;
}

/** 游客只见公开演示库；管理员见全部 */
export function listNovels(viewer: 'admin' | 'guest'): { id: string; title: string; owner: string; chunkCount: number }[] {
  const where = viewer === 'guest' ? "WHERE n.owner = 'public'" : '';
  return db.prepare(`
    SELECT n.id, n.title, n.owner, COUNT(c.id) as chunkCount
    FROM novels n LEFT JOIN chunks c ON c.novel_id = n.id
    ${where}
    GROUP BY n.id ORDER BY n.created_at DESC
  `).all() as any;
}

export function deleteNovel(novelId: string): boolean {
  db.prepare('DELETE FROM chunks WHERE novel_id = ?').run(novelId);
  const result = db.prepare('DELETE FROM novels WHERE id = ?').run(novelId);
  return result.changes > 0;
}

export function insertChunks(novelId: string, chunks: { chapter: string; index: number; text: string; vector: number[] }[]) {
  const stmt = db.prepare('INSERT INTO chunks (novel_id, chapter, idx, text, vector) VALUES (?, ?, ?, ?, ?)');
  // node:sqlite 没有 better-sqlite3 的 .transaction()，手动控制事务
  db.exec('BEGIN');
  try {
    for (const c of chunks) stmt.run(novelId, c.chapter, c.index, c.text, JSON.stringify(c.vector));
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
