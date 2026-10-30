import 'dotenv/config';
import { DatabaseSync } from 'node:sqlite';
import { generateBookSummary } from '../src/rag/summaries.js';
import { getNovelByTitle } from '../src/rag/store.js';

const novel = getNovelByTitle(process.argv[2] || '绍宋');
if (!novel) throw new Error('not found');
const db = new DatabaseSync('data/data.db');
const rows = db.prepare('SELECT text FROM chunks WHERE novel_id = ? AND level IN (1,2) ORDER BY level DESC, idx').all(novel.id) as { text: string }[];
console.log(`输入 ${rows.length} 条摘要节点`);
const summary = await generateBookSummary(novel.id, rows.map((r) => r.text), (s) => {
  console.log(new Date().toISOString().slice(11, 19), s);
});
console.log('=== 全书梗概 ===\n' + summary);
