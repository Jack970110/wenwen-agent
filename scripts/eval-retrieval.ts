import { readFileSync } from 'node:fs';
import { retrieve } from '../src/rag/retrieve.js';
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
  const evalSet = JSON.parse(readFileSync('data/eval-set.json', 'utf-8'));
  const cases: { q: string; expectChapter: string }[] = evalSet.cases;

  console.log(`评测集 ${cases.length} 条，命中率@${K}：\n`);

  let hits = 0;
  const details: string[] = [];
  for (const c of cases) {
    const results = await retrieve(c.q, K);
    const hit = results.some((r) => r.chapter === c.expectChapter);
    if (hit) hits++;
    const top1 = results[0] ? `${results[0].chapter}${results[0].reranked ? '' : '(未精排)'}` : '(空)';
    details.push(`${hit ? '✅' : '❌'} ${c.q}
   期望: ${c.expectChapter} | top1: ${top1}${hit ? '' : `\n   召回: ${results.map((r) => r.chapter).join(', ')}`}`);
  }

  details.forEach((d) => console.log(d + '\n'));
  console.log(`──────────────`);
  console.log(`命中率@${K}: ${hits}/${cases.length} = ${((hits / cases.length) * 100).toFixed(0)}%`);
}

main().catch((err) => {
  console.error('❌ 评测失败:', err.message);
  process.exit(1);
});
