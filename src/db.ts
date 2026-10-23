import { DatabaseSync } from 'node:sqlite';
import type { UIMessage } from 'ai';

/**
 * 会话持久化：SQLite（Node 22 内置 node:sqlite，无需额外依赖）。
 * 简化设计：messages 整体存 JSON 文本，会话级别读写。
 * 生产环境可换成逐条消息表 + Redis 缓存，接口不变。
 */
const db = new DatabaseSync('data.db');
db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL DEFAULT '新对话',
    messages TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

export function createSession(): string {
  const id = crypto.randomUUID();
  db.prepare('INSERT INTO sessions (id) VALUES (?)').run(id);
  return id;
}

export function getMessages(sessionId: string): UIMessage[] {
  const row = db.prepare('SELECT messages FROM sessions WHERE id = ?').get(sessionId) as
    | { messages: string }
    | undefined;
  return row ? JSON.parse(row.messages) : [];
}

export function getTitle(sessionId: string): string {
  const row = db.prepare('SELECT title FROM sessions WHERE id = ?').get(sessionId) as
    | { title: string }
    | undefined;
  return row?.title ?? '新对话';
}

export function appendMessage(sessionId: string, message: UIMessage): void {
  const list = getMessages(sessionId);
  // 第一条用户消息作为会话标题（列表展示用）
  if (message.role === 'user' && getTitle(sessionId) === '新对话') {
    const text = message.parts.find((p) => p.type === 'text')?.text ?? '新对话';
    db.prepare('UPDATE sessions SET title = ? WHERE id = ?').run(text.slice(0, 30), sessionId);
  }
  list.push(message);
  db.prepare('UPDATE sessions SET messages = ? WHERE id = ?').run(JSON.stringify(list), sessionId);
}

export function listSessions(): { id: string; title: string; createdAt: string }[] {
  return db
    .prepare('SELECT id, title, created_at as createdAt FROM sessions ORDER BY created_at DESC LIMIT 50')
    .all() as { id: string; title: string; createdAt: string }[];
}

export function deleteSession(sessionId: string): boolean {
  const result = db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
  return result.changes > 0;
}
