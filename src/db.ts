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

/* ==================== 长任务（平台层）====================
 * 长任务和会话的本质区别：不再是「一次请求一条 SSE 流」，
 * 而是「有状态的后台作业」——受理即返回，过程落库，前端轮询。
 * steps 存 JSON 数组（剧本定义的步骤 + 状态 + 中间产物），
 * result 存最终产物（报告 markdown 等）。
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'running',
    owner TEXT NOT NULL,
    steps TEXT NOT NULL DEFAULT '[]',
    result TEXT,
    error TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_tasks_owner ON tasks(owner, created_at);
`);

export interface TaskStep {
  name: string;
  status: 'pending' | 'running' | 'done' | 'failed';
  /** 中间产物摘要：前端展开步骤时展示（阅读笔记、数据发现等） */
  note?: string;
}

export interface TaskRow {
  id: string;
  type: string;
  title: string;
  status: 'running' | 'done' | 'failed' | 'cancelled';
  owner: string;
  steps: TaskStep[];
  result?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

function rowToTask(row: any): TaskRow {
  return {
    id: row.id, type: row.type, title: row.title, status: row.status, owner: row.owner,
    steps: JSON.parse(row.steps || '[]'),
    result: row.result || undefined, error: row.error || undefined,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

export function createTaskRow(id: string, type: string, title: string, owner: string, steps: TaskStep[]): void {
  db.prepare('INSERT INTO tasks (id, type, title, owner, steps) VALUES (?, ?, ?, ?, ?)')
    .run(id, type, title, owner, JSON.stringify(steps));
}

export function getTaskRow(id: string, owner: string): TaskRow | undefined {
  const row = db.prepare('SELECT * FROM tasks WHERE id = ? AND owner = ?').get(id, owner);
  return row ? rowToTask(row) : undefined;
}

export function listTaskRows(owner: string, limit = 20): TaskRow[] {
  return (db.prepare('SELECT * FROM tasks WHERE owner = ? ORDER BY created_at DESC LIMIT ?').all(owner, limit) as any[])
    .map(rowToTask);
}

export function updateTaskSteps(id: string, steps: TaskStep[]): void {
  db.prepare("UPDATE tasks SET steps = ?, updated_at = datetime('now') WHERE id = ?").run(JSON.stringify(steps), id);
}

export function finishTaskRow(id: string, status: 'done' | 'failed' | 'cancelled', result?: string, error?: string): void {
  db.prepare("UPDATE tasks SET status = ?, result = ?, error = ?, updated_at = datetime('now') WHERE id = ?")
    .run(status, result ?? null, error ?? null, id);
}

/* ==================== 数据集（阅读数据）====================
 * 用户上传的 CSV 归一化后存两张表：datasets 元信息 + chapter_stats 明细。
 * 数据集是独立实体（有 id/name/owner），dataService 按 dataset 查数，
 * 剧本按 name 匹配知识库书名做原文归因。
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS datasets (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    owner TEXT NOT NULL,
    row_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS chapter_stats (
    dataset_id TEXT NOT NULL,
    chapter_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    readers_7d INTEGER,
    finish_rate_7d REAL,
    net_follow_7d INTEGER,
    published_at TEXT,
    word_count INTEGER,
    PRIMARY KEY (dataset_id, chapter_id)
  );
`);

export interface DatasetRow {
  id: string;
  name: string;
  owner: string;
  rowCount: number;
  createdAt: string;
}

export function createDatasetRow(id: string, name: string, owner: string, rowCount: number): void {
  db.prepare('INSERT INTO datasets (id, name, owner, row_count) VALUES (?, ?, ?, ?)').run(id, name, owner, rowCount);
}

export function getDatasetRow(id: string): DatasetRow | undefined {
  const row = db.prepare('SELECT * FROM datasets WHERE id = ?').get(id) as any;
  return row ? { id: row.id, name: row.name, owner: row.owner, rowCount: row.row_count, createdAt: row.created_at } : undefined;
}

export function findDatasetByName(name: string): DatasetRow | undefined {
  const row = db.prepare('SELECT * FROM datasets WHERE name = ? ORDER BY created_at DESC LIMIT 1').get(name) as any;
  return row ? { id: row.id, name: row.name, owner: row.owner, rowCount: row.row_count, createdAt: row.created_at } : undefined;
}

export function listDatasetRows(owner: string): DatasetRow[] {
  return (db.prepare("SELECT * FROM datasets WHERE owner = ? OR owner = 'public' ORDER BY created_at DESC").all(owner) as any[])
    .map((row) => ({ id: row.id, name: row.name, owner: row.owner, rowCount: row.row_count, createdAt: row.created_at }));
}

export function deleteDatasetRow(id: string): boolean {
  db.prepare('DELETE FROM chapter_stats WHERE dataset_id = ?').run(id);
  return Number(db.prepare('DELETE FROM datasets WHERE id = ?').run(id).changes) > 0;
}

/** 归一化行：与 mockData.ChapterStat 字段语义一致 */
export interface StatRow {
  chapterId: number;
  title: string;
  readers7d: number;
  finishRate7d: number;
  netFollow7d?: number;
  publishedAt?: string;
  wordCount?: number;
  comments?: number;
  negativeRate?: number;
  income?: number;
}

export function insertChapterStats(datasetId: string, rows: StatRow[]): void {
  const stmt = db.prepare(
    'INSERT OR REPLACE INTO chapter_stats (dataset_id, chapter_id, title, readers_7d, finish_rate_7d, net_follow_7d, published_at, word_count, comments_7d, negative_rate, income_7d) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  for (const r of rows) {
    stmt.run(datasetId, r.chapterId, r.title, r.readers7d, r.finishRate7d, r.netFollow7d ?? null, r.publishedAt ?? null, r.wordCount ?? null, r.comments ?? null, r.negativeRate ?? null, r.income ?? null);
  }
}

export function getChapterStatsRows(datasetId: string): StatRow[] {
  return db.prepare(
    'SELECT chapter_id AS chapterId, title, readers_7d AS readers7d, finish_rate_7d AS finishRate7d, net_follow_7d AS netFollow7d, published_at AS publishedAt, word_count AS wordCount, comments_7d AS comments, negative_rate AS negativeRate, income_7d AS income FROM chapter_stats WHERE dataset_id = ? ORDER BY chapter_id',
  ).all(datasetId) as unknown as StatRow[];
}

/* ---- 数据集多维扩展（三期）：评论/差评率/收入。老库补列 ---- */
addColumnIfMissing('chapter_stats', 'comments_7d', 'INTEGER');
addColumnIfMissing('chapter_stats', 'negative_rate', 'REAL');
addColumnIfMissing('chapter_stats', 'income_7d', 'REAL');

export function updateDatasetRowCount(id: string, rowCount: number): void {
  db.prepare('UPDATE datasets SET row_count = ? WHERE id = ?').run(rowCount, id);
}

export function countChapterStats(id: string): number {
  const row = db.prepare('SELECT COUNT(*) AS c FROM chapter_stats WHERE dataset_id = ?').get(id) as any;
  return Number(row?.c ?? 0);
}

export function setDatasetOwner(id: string, owner: string): void {
  db.prepare('UPDATE datasets SET owner = ? WHERE id = ?').run(owner, id);
}
