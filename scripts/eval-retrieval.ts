import { readFileSync } from 'node:fs';
import { retrieve } from '../src/rag/retrieve.js';
import { getNovelByTitle } from '../src/rag/store.js';
import 'dotenv/config';

/**
 * 检索召回评测：跑 eval-set.json 里的标注用例，算命中率@K。
 * 用法：npm run eval -- [K]（默认 K=3）
 *
 * 走 retrieve() 统一入口（向量召回 + rerank 精排），保证评测测的就是线上真实链路。
 * 改切块/检索策略前后各跑一次，命中率变化就是调优效果的客观证据。
 */
async function main() {
  const K = Number(process.argv[2]) || 3;
  // 支持指定标注文件（跨书泛化对比用）：npm run eval -- [K] [--file data/eval-set-xxx.json]
  const fileFlag = process.argv.indexOf('--file');
  const evalPath = fileFlag >= 0 ? process.argv[fileFlag + 1] : 'data/eval-set.json';
  const evalSet = JSON.parse(readFileSync(evalPath, 'utf-8'));
  // accept: 可选多答案数组——事件横跨多章（如连续上/中/下章）时命中任一即算过
  // book: 可选书名过滤——scope 到单书检索（模拟会话聚焦绑定的真实行为），不传则全池检索
  // --book <书名>：全局 scope 覆盖（跨书/跨池对比用，优先级低于条目内 book 字段）
  const globalBookIdx = process.argv.indexOf('--book');
  const globalBook = globalBookIdx >= 0 ? process.argv[globalBookIdx + 1] : undefined;
  const cases: { q: string; expectChapter: string; accept?: string[]; book?: string }[] = evalSet.cases;
  const bookIds = new Map<string, string | undefined>();
  for (const c of cases) {
    const b = c.book ?? globalBook;
    if (b) c.book = b;
    if (c.book && !bookIds.has(c.book)) bookIds.set(c.book, getNovelByTitle(c.book)?.id);
  }
  for (const [b, id] of bookIds) if (!id) console.error(`⚠️ 书《${b}》不在库中，相关用例将退化为全池检索`);

  console.log(`标注文件 ${evalPath}，评测集 ${cases.length} 条，命中率@${K}：\n`);

  let hits = 0;
  const details: string[] = [];
  for (const c of cases) {
    const results = await retrieve(c.q, K, c.book ? bookIds.get(c.book) : undefined);
    const expected = [c.expectChapter, ...(c.accept ?? [])];
    const hit = results.some((r) => expected.includes(r.chapter));
    if (hit) hits++;
    const top1 = results[0] ? `${results[0].chapter}${results[0].reranked ? '' : '(未精排)'}` : '(空)';
    details.push(`${hit ? '✅' : '❌'} ${c.q}
   期望: ${c.expectChapter}${c.accept?.length ? `（或 ${c.accept.join(' / ')}）` : ''} | top1: ${top1}${hit ? '' : `\n   召回: ${results.map((r) => r.chapter).join(', ')}`}`);
  }

  details.forEach((d) => console.log(d + '\n'));
  console.log(`──────────────`);
  console.log(`命中率@${K}: ${hits}/${cases.length} = ${((hits / cases.length) * 100).toFixed(0)}%`);
}

main().catch((err) => {
  console.error('❌ 评测失败:', err.message);
  process.exit(1);
});
