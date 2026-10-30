/**
 * 存量书摘要层回填：分级功能上线前入库的书只有 level 0 原文块，
 * 没有 meta.tier、没有章/段摘要层——全局类问题（"讲了什么故事"）必然答不好。
 *
 * 用法: npx tsx scripts/backfill-summaries.ts <书名>
 * 流程: 从 chunks 表重建 NovelChunk[]（前缀行解析全局章号/卷/章名）
 *       → 按 totalChars 重算 tier 补写 meta → buildSummaryLayer 生成 level 1/2
 * 成本: T4 一本 433 章的书 ≈ 448 次 LLM 摘要 + 同等量级 embedding，约 10-20 分钟
 */
import 'dotenv/config';
import { DatabaseSync } from 'node:sqlite';
import { buildSummaryLayer } from '../src/rag/summaries.js';
import { determineTier, type Tier } from '../src/rag/tier.js';
import type { NovelChunk } from '../src/rag/chunker.js';
import { getNovelByTitle, getNovelMeta, updateNovelMeta } from '../src/rag/store.js';

const title = process.argv[2];
if (!title) {
  console.error('用法: npx tsx scripts/backfill-summaries.ts <书名>');
  process.exit(1);
}

const novel = getNovelByTitle(title);
if (!novel) throw new Error(`知识库中没有《${title}》`);
const meta = getNovelMeta(novel.id);
if (!meta) throw new Error('该书没有结构元数据，请先跑服务端启动自愈或 npm run ingest 重新入库');

// 已有摘要层则跳过（幂等：重跑只补缺）
const db = new DatabaseSync('data/data.db');
const lv = db.prepare('SELECT level, COUNT(*) c FROM chunks WHERE novel_id = ? GROUP BY level').all(novel.id) as { level: number; c: number }[];
console.log('现有块层级分布:', JSON.stringify(lv));

const tier: Tier = meta.tier ?? determineTier(meta.totalChars);
console.log(`《${title}》 totalChars=${meta.totalChars} → tier=${tier}${meta.tier ? '（meta 已有）' : '（重算，将写回 meta）'}`);

if (tier !== 'T3' && tier !== 'T4') {
  console.error(`该书为 ${tier}，不需要摘要层，退出`);
  process.exit(0);
}

if (!meta.tier || meta.tier !== tier) {
  updateNovelMeta(novel.id, { ...meta, tier });
  console.log('✅ meta.tier 已补写');
}

// 从 level 0 块重建 NovelChunk[]：text 首行前缀解析全局章号/卷/章名
const PREFIX_RE = /^\[全书第(\d+)章\] (?:([^·\n]+) · )?(.+)$/;
const rows = db.prepare('SELECT chapter, idx, text FROM chunks WHERE novel_id = ? AND level = 0 ORDER BY idx').all(novel.id) as
  | { chapter: string; idx: number; text: string }[]
  | undefined;
if (!rows?.length) throw new Error('该书没有 level 0 原文块');

const chunks: NovelChunk[] = [];
let lastNo = 0;
let lastLabel = '';
for (const r of rows) {
  const firstLine = r.text.split('\n')[0];
  const m = PREFIX_RE.exec(firstLine);
  const globalChapter = m ? Number(m[1]) : lastNo || 1;
  const volumeLabel = m?.[2];
  const chapterLabel = m ? m[3] : r.chapter;
  chunks.push({ globalChapter, chapterLabel, volumeLabel, index: r.idx, text: r.text });
  lastNo = globalChapter;
  lastLabel = chapterLabel;
}
console.log(`重建 ${chunks.length} 个原文块，覆盖 ${new Set(chunks.map((c) => c.globalChapter)).size} 章`);

const count = await buildSummaryLayer(novel.id, chunks, tier, (done, total) => {
  process.stdout.write(`\r摘要生成 ${done}/${total}`);
});
process.stdout.write('\n');
console.log(`✅ 摘要层回填完成：新增 ${count} 个摘要节点`);
