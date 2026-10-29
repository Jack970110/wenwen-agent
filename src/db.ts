import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';

/**
 * 存储层自定义消息类型：不直接用 AI SDK 的 UIMessage，
 * 因为要持久化工具调用事件（text 之外的 part），自定义类型更直白。
 * text part = 正文；tool part = 工具调用记录（前端回看时还原时间线）。
 */
export interface StoredPart {
  type: 'text' | 'tool';
  text?: string;
  name?: string;
  args?: string;
  error?: boolean;
}

export interface StoredMessage {
  id: string;
  role: 'user' | 'assistant';
  parts: StoredPart[];
}

/**
 * 会话持久化：SQLite（Node 22 内置 node:sqlite，无需额外依赖）。
 * 简化设计：messages 整体存 JSON 文本，会话级别读写。
 * 生产环境可换成逐条消息表 + Redis 缓存，接口不变。
 *
 * db 文件放 data/ 目录：Docker 数据卷挂载点（容器重建不丢数据）。
 */
mkdirSync('data', { recursive: true });
const db = new DatabaseSync('data/data.db');
db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL DEFAULT '新对话',
    messages TEXT NOT NULL DEFAULT '[]',
    visitor_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

/** 轻量迁移：老库补列（列存在则跳过） */
function addColumnIfMissing(table: string, column: string, def: string) {
  const cols = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
}
addColumnIfMissing('sessions', 'visitor_id', 'TEXT');
db.exec(`
  -- 防薅额度：全站日限额 + 单 IP 每分钟限频
  CREATE TABLE IF NOT EXISTS usage_daily (date TEXT PRIMARY KEY, count INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE IF NOT EXISTS rate_ip (ip TEXT, minute TEXT, count INTEGER, PRIMARY KEY (ip, minute));
`);
// 老数据归属迁移：历史会话归管理员（novels 的 owner 列在 store.ts 里迁移）
db.exec(`UPDATE sessions SET visitor_id = 'admin' WHERE visitor_id IS NULL`);
// 会话级聚焦小说：null = 全库检索
addColumnIfMissing('sessions', 'focus_novel', 'TEXT');

/** 全站日限额 + 单 IP 限频：每次 /api/chat 调用前检查并计数 */
export function checkChatLimits(ip: string): { allowed: boolean; reason?: string } {
  const DAILY_LIMIT = 200;
  const IP_PER_MINUTE = 5;
  const day = new Date().toISOString().slice(0, 10);
  const minute = new Date().toISOString().slice(0, 16);

  const daily = (db.prepare('SELECT count FROM usage_daily WHERE date = ?').get(day) as { count: number } | undefined)?.count ?? 0;
  if (daily >= DAILY_LIMIT) return { allowed: false, reason: '今日体验额度已用完，欢迎明天再来' };

  const minuteKey = `${day} ${minute.slice(11)}`;
  const perMin = (db.prepare('SELECT count FROM rate_ip WHERE ip = ? AND minute = ?').get(ip, minute) as { count: number } | undefined)?.count ?? 0;
  if (perMin >= IP_PER_MINUTE) return { allowed: false, reason: '操作过于频繁，请稍等一分钟' };

  db.prepare('INSERT INTO usage_daily (date, count) VALUES (?, 1) ON CONFLICT(date) DO UPDATE SET count = count + 1').run(day);
  db.prepare('INSERT INTO rate_ip (ip, minute, count) VALUES (?, ?, 1) ON CONFLICT(ip, minute) DO UPDATE SET count = count + 1').run(ip, minute);
  return { allowed: true };
}

/**
 * 会话按访客隔离：游客传自己的 visitorId 只看自己的；
 * 管理员传 'admin' 看自己的。历史数据已迁移为 'admin'。
 * 所有会话读写函数都要求 visitorId，接口层负责从身份中解析。
 */
export function createSession(visitorId: string): string {
  const id = crypto.randomUUID();
  db.prepare('INSERT INTO sessions (id, visitor_id) VALUES (?, ?)').run(id, visitorId);
  return id;
}

/** 会话元信息（含聚焦小说），用于前端选择器状态恢复 */
export function getSessionMeta(sessionId: string, visitorId: string): { id: string; title: string; focusNovel: string | null } | undefined {
  const row = db
    .prepare('SELECT id, title, focus_novel as focusNovel FROM sessions WHERE id = ? AND visitor_id = ?')
    .get(sessionId, visitorId) as { id: string; title: string; focusNovel: string | null } | undefined;
  return row;
}

export function setSessionFocus(sessionId: string, visitorId: string, novelTitle: string | null): boolean {
  const result = db.prepare('UPDATE sessions SET focus_novel = ? WHERE id = ? AND visitor_id = ?').run(novelTitle, sessionId, visitorId);
  return Number(result.changes) > 0;
}

export function getSessionFocus(sessionId: string, visitorId: string): string | null {
  const row = db.prepare('SELECT focus_novel FROM sessions WHERE id = ? AND visitor_id = ?').get(sessionId, visitorId) as
    | { focus_novel: string | null }
    | undefined;
  return row?.focus_novel ?? null;
}

export function sessionExists(sessionId: string, visitorId: string): boolean {
  return !!db.prepare('SELECT 1 FROM sessions WHERE id = ? AND visitor_id = ?').get(sessionId, visitorId);
}

export function getMessages(sessionId: string, visitorId: string): StoredMessage[] {
  const row = db.prepare('SELECT messages FROM sessions WHERE id = ? AND visitor_id = ?').get(sessionId, visitorId) as
    | { messages: string }
    | undefined;
  return row ? JSON.parse(row.messages) : [];
}

export function getTitle(sessionId: string, visitorId: string): string {
  const row = db.prepare('SELECT title FROM sessions WHERE id = ? AND visitor_id = ?').get(sessionId, visitorId) as
    | { title: string }
    | undefined;
  return row?.title ?? '新对话';
}

export function appendMessage(sessionId: string, visitorId: string, message: StoredMessage): void {
  const list = getMessages(sessionId, visitorId);
  // 第一条用户消息作为会话标题（列表展示用）
  if (message.role === 'user' && getTitle(sessionId, visitorId) === '新对话') {
    const text = message.parts.find((p) => p.type === 'text')?.text ?? '新对话';
    db.prepare('UPDATE sessions SET title = ? WHERE id = ? AND visitor_id = ?').run(text.slice(0, 30), sessionId, visitorId);
  }
  list.push(message);
  db.prepare('UPDATE sessions SET messages = ? WHERE id = ? AND visitor_id = ?').run(JSON.stringify(list), sessionId, visitorId);
}

export function listSessions(visitorId: string): { id: string; title: string; focusNovel: string | null; createdAt: string }[] {
  return db
    .prepare('SELECT id, title, focus_novel as focusNovel, created_at as createdAt FROM sessions WHERE visitor_id = ? ORDER BY created_at DESC LIMIT 50')
    .all(visitorId) as { id: string; title: string; focusNovel: string | null; createdAt: string }[];
}

export function deleteSession(sessionId: string, visitorId: string): boolean {
  const result = db.prepare('DELETE FROM sessions WHERE id = ? AND visitor_id = ?').run(sessionId, visitorId);
  return result.changes > 0;
}

/**
 * 登录收编（claim）：游客登录瞬间，把匿名身份下的会话迁移到正式账号名下。
 * 这是「先体验后注册」转化漏斗的临门一脚——体验数据无缝继承，不用重新开始。
 */
export function claimGuestSessions(fromVisitorId: string, toOwner: string): number {
  const result = db.prepare('UPDATE sessions SET visitor_id = ? WHERE visitor_id = ?').run(toOwner, fromVisitorId);
  return Number(result.changes);
}

/**
 * TTL 清理：删除超过 N 天的游客会话（管理员账号名下的不受影响）。
 * 防止匿名数据无限膨胀——业界标准的成本治理手段。
 * 服务启动时执行一次即可（服务会随部署频繁重启，等效定时任务）。
 */
export function cleanupStaleGuestSessions(days: number, protectedOwners: string[]): number {
  const placeholders = protectedOwners.map(() => '?').join(',') || "''";
  const result = db
    .prepare(`DELETE FROM sessions WHERE visitor_id NOT IN (${placeholders}) AND created_at < datetime('now', '-' || ? || ' days')`)
    .run(...protectedOwners, days);
  return Number(result.changes);
}
