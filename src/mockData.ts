/**
 * 模拟数据层 —— 按书名组织的多份章节阅读数据（v1 mock，v2 换 SQLite 表时接口不变）。
 *
 * 数据契约（剧本 dataAnalysis 硬依赖的语义）：
 * - finishRate7d ∈ 0~1：异常检测找最低值
 * - netFollow7d 可为负：负值 = 追更流失（问题章节）
 * - readers7d 首条非 0：趋势计算 (last-first)/first
 * - title 需与入库小说的章节标题对齐，否则「原文归因」检索不到（报告仍可出，归因层为空）
 *
 * 两份数据故意做成对照模式，验证 agent 能区分：
 * - 雪夜来客：中期崩盘型（完读率第 3 章起下滑、第 5 章追更转负、第 7 章反转回升）
 * - 星落长安：节奏健康型（完读率稳定高位、追更持续净增）——用于对照报告质量
 */

export interface ChapterStat {
  chapterId: number;
  title: string;
  wordCount: number;
  publishedAt: string;
  readers7d: number;
  finishRate7d: number;
  netFollow7d: number;
}

/** 《雪夜来客》：中期崩盘型（现有演示数据，原样保留） */
const xueye: ChapterStat[] = [
  { chapterId: 1, title: '第一章 雪夜来客', wordCount: 3200, publishedAt: '2026-09-01', readers7d: 52000, finishRate7d: 0.92, netFollow7d: 1200 },
  { chapterId: 2, title: '第二章 旧宅疑云', wordCount: 3500, publishedAt: '2026-09-03', readers7d: 48100, finishRate7d: 0.89, netFollow7d: 980 },
  { chapterId: 3, title: '第三章 地窖', wordCount: 2900, publishedAt: '2026-09-05', readers7d: 45300, finishRate7d: 0.71, netFollow7d: 410 },
  { chapterId: 4, title: '第四章 缺页的日记', wordCount: 4100, publishedAt: '2026-09-08', readers7d: 43900, finishRate7d: 0.66, netFollow7d: 150 },
  { chapterId: 5, title: '第五章 雨夜追踪', wordCount: 3800, publishedAt: '2026-09-10', readers7d: 41200, finishRate7d: 0.63, netFollow7d: -60 },
  { chapterId: 6, title: '第六章 消失的证人', wordCount: 5200, publishedAt: '2026-09-13', readers7d: 38900, finishRate7d: 0.58, netFollow7d: -210 },
  { chapterId: 7, title: '第七章 反转', wordCount: 3000, publishedAt: '2026-09-15', readers7d: 40200, finishRate7d: 0.85, netFollow7d: 700 },
  { chapterId: 8, title: '第八章 真相之外', wordCount: 3600, publishedAt: '2026-09-17', readers7d: 38700, finishRate7d: 0.81, netFollow7d: 350 },
];

/** 《星落长安》：节奏健康型（对照数据） */
const xingluo: ChapterStat[] = [
  { chapterId: 1, title: '第一章 上元灯劫', wordCount: 3400, publishedAt: '2026-10-01', readers7d: 31000, finishRate7d: 0.9, netFollow7d: 860 },
  { chapterId: 2, title: '第二章 波斯胡商', wordCount: 3600, publishedAt: '2026-10-03', readers7d: 31500, finishRate7d: 0.88, netFollow7d: 720 },
  { chapterId: 3, title: '第三章 夜漏声里', wordCount: 3300, publishedAt: '2026-10-05', readers7d: 32100, finishRate7d: 0.87, netFollow7d: 810 },
  { chapterId: 4, title: '第四章 棋逢对手', wordCount: 3700, publishedAt: '2026-10-07', readers7d: 32900, finishRate7d: 0.9, netFollow7d: 950 },
  { chapterId: 5, title: '第五章 火烧西市', wordCount: 4100, publishedAt: '2026-10-09', readers7d: 34200, finishRate7d: 0.91, netFollow7d: 1100 },
  { chapterId: 6, title: '第六章 金吾卫的阴影', wordCount: 3500, publishedAt: '2026-10-11', readers7d: 35600, finishRate7d: 0.89, netFollow7d: 980 },
  { chapterId: 7, title: '第七章 双面人', wordCount: 3200, publishedAt: '2026-10-13', readers7d: 36400, finishRate7d: 0.92, netFollow7d: 1240 },
  { chapterId: 8, title: '第八章 破晓之前', wordCount: 3900, publishedAt: '2026-10-15', readers7d: 37100, finishRate7d: 0.9, netFollow7d: 1310 },
];

/**
 * 内置演示数据集：服务启动时 seed 进 datasets 表（幂等）。
 * 名字与知识库入库的小说同名时，报告可做原文归因。
 */
export const builtinDatasets: Record<string, ChapterStat[]> = {
  '雪夜来客': xueye,
  '星落长安': xingluo,
};
