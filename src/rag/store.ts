import { DatabaseSync } from 'node:sqlite';
import { cosineSimilarity } from './embed.js';

/**
 * 向量存储（v3a MVP）：SQLite 存向量 JSON，查询时全量暴力余弦检索。
 *
 * 为什么不先上 pgvector：一本小说几百个块，暴力检索毫秒级，引入向量库是过度设计。
 * 等块数上万、暴力检索成为瓶颈时再迁——届时只改这个文件，上层无感。
 * 这个"什么时候才需要向量数据库"的判断本身就是面试考点。
 */

const db = new DatabaseSync('data.db');
db.exec(`
  CREATE TABLE IF NOT EXISTS novels (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
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

export function createNovel(title: string): string {
  const id = crypto.randomUUID();
  db.prepare('INSERT INTO novels (id, title) VALUES (?, ?)').run(id, title);
  return id;
}

export function listNovels(): { id: string; title: string; chunkCount: number }[] {
  return db.prepare(`
    SELECT n.id, n.title, COUNT(c.id) as chunkCount
    FROM novels n LEFT JOIN chunks c ON c.novel_id = n.id
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

export interface RetrievedChunk {
  chapter: string;
  text: string;
  similarity: number;
}

/** 语义检索：余弦相似度暴力扫描，返回 topK */
export function searchNovelChunks(queryVector: number[], topK = 5): RetrievedChunk[] {
  const rows = db.prepare('SELECT chapter, text, vector FROM chunks').all() as {
    chapter: string; text: string; vector: string;
  }[];
  return rows
    .map((r) => ({
      chapter: r.chapter,
      text: r.text,
      similarity: cosineSimilarity(queryVector, JSON.parse(r.vector)),
    }))
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, topK);
}
