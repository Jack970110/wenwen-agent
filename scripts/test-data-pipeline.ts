import { queryChaptersData, analyzeTrendData } from '../src/dataService.js';
import { seedBuiltinDatasets } from '../src/datasets/store.js';

/**
 * dataAnalysis 确定性管线的数字断言测试（零模型调用，CI 可跑）：
 * 评测锚定确定性环节——取数与趋势分析的结果必须精确可复现。
 *
 * 构造数据用内置演示集（mockData 的对照模式）：
 * - 雪夜来客：中期崩盘型（完读率第 3 章起下滑、第 5 章追更转负）
 * - 星落长安：节奏健康型（完读率稳定高位、追更持续净增）
 * seedBuiltinDatasets 幂等（库里有则跳过），断言只读不写。
 */

let passed = 0;
let failed = 0;

function assert(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { passed++; console.log(`✅ ${name}`); }
  else { failed++; console.log(`❌ ${name}\n   期望: ${JSON.stringify(expected)}\n   实际: ${JSON.stringify(actual)}`); }
}

// 独立临时库：避免污染 data/data.db（db.ts 的库路径不可注入，这里用 seed 到真实库的
// 幂等性 + 只读断言来保证安全——seedBuiltinDatasets 已存在则跳过）
seedBuiltinDatasets();
/* ---- 取数 ---- */
const xueye = queryChaptersData(1, 99999, '雪夜来客') as any[];
assert('取数：雪夜来客 8 章', xueye.length, 8);
assert('取数：章节序号连续', xueye.map((c) => c.chapterId), [1, 2, 3, 4, 5, 6, 7, 8]);

const range = queryChaptersData(3, 5, '雪夜来客') as any[];
assert('取数：区间过滤 [3,5]', range.map((c) => c.chapterId), [3, 4, 5]);

const missing = queryChaptersData(1, 8, '不存在的书') as any;
assert('取数：书名不存在报错', missing.error, '没有名为「不存在的书」的数据集');

/* ---- 趋势分析：崩盘型 ---- */
const crash = analyzeTrendData(1, 8, '雪夜来客') as any;
assert('崩盘型：阅读人数变化 52000→38700', crash.readerChangePercent, -25.6);
assert('崩盘型：完读率最低是第 6 章（0.58）', crash.lowestFinishRate.chapter, '第六章 消失的证人');
assert('崩盘型：最低完读率 0.58', crash.lowestFinishRate.rate, 0.58);
assert('崩盘型：追更流失章',
  crash.chaptersLosingFollowers.map((c: any) => c.chapter),
  ['第五章 雨夜追踪', '第六章 消失的证人']);
assert('崩盘型：多维发现触发（第 6 章字数 5200 显著超均值，完读率也最低）',
  (crash.extraFindings as string[]).some((s) => s.includes('章节过长')), true);

/* ---- 趋势分析：健康型（对照组） ---- */
const healthy = analyzeTrendData(1, 8, '星落长安') as any;
assert('健康型：阅读人数持续上升', healthy.readerChangePercent > 0, true);
assert('健康型：无追更流失章节', healthy.chaptersLosingFollowers, []);
assert('健康型：完读率稳定 0.87+', healthy.lowestFinishRate.rate >= 0.87, true);

/* ---- 多维发现：按可选列触发 ---- */
// 星落长安 seed 数据只有五个必填维 + wordCount，无评论/差评/收入列
const healthyExtra = healthy.extraFindings as string[] | undefined;
assert('健康型：字数维度发现不误报（章长均衡）', healthyExtra?.some((s) => s.includes('章节过长')) ?? false, false);

console.log('──────────────');
console.log(`数字断言: ${passed} 通过 / ${failed} 失败`);
if (failed > 0) process.exit(1);
