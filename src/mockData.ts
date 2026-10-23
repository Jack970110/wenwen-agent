/**
 * 模拟数据层 —— v1 先用内存 mock，模拟"小说章节阅读数据"。
 * v2 可以换成 SQLite / 真实 API，工具层代码不用变（这就是工具抽象的好处）。
 */

export interface ChapterStat {
  chapterId: number;
  title: string;
  wordCount: number;
  /** 发布日期 */
  publishedAt: string;
  /** 7 日阅读人数 */
  readers7d: number;
  /** 7 日完读率 0~1 */
  finishRate7d: number;
  /** 7 日净增追更人数 */
  netFollow7d: number;
}

export const chapterStats: ChapterStat[] = [
  { chapterId: 1, title: '第一章 雪夜来客', wordCount: 3200, publishedAt: '2026-09-01', readers7d: 52000, finishRate7d: 0.92, netFollow7d: 1200 },
  { chapterId: 2, title: '第二章 旧宅疑云', wordCount: 3500, publishedAt: '2026-09-03', readers7d: 48100, finishRate7d: 0.89, netFollow7d: 980 },
  { chapterId: 3, title: '第三章 地窖', wordCount: 2900, publishedAt: '2026-09-05', readers7d: 45300, finishRate7d: 0.71, netFollow7d: 410 },
  { chapterId: 4, title: '第四章 缺页的日记', wordCount: 4100, publishedAt: '2026-09-08', readers7d: 43900, finishRate7d: 0.66, netFollow7d: 150 },
  { chapterId: 5, title: '第五章 雨夜追踪', wordCount: 3800, publishedAt: '2026-09-10', readers7d: 41200, finishRate7d: 0.63, netFollow7d: -60 },
  { chapterId: 6, title: '第六章 消失的证人', wordCount: 5200, publishedAt: '2026-09-13', readers7d: 38900, finishRate7d: 0.58, netFollow7d: -210 },
  { chapterId: 7, title: '第七章 反转', wordCount: 3000, publishedAt: '2026-09-15', readers7d: 40200, finishRate7d: 0.85, netFollow7d: 700 },
  { chapterId: 8, title: '第八章 真相之外', wordCount: 3600, publishedAt: '2026-09-17', readers7d: 38700, finishRate7d: 0.81, netFollow7d: 350 },
];
