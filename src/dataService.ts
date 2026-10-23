import { chapterStats } from './mockData.js';

/**
 * 数据服务层：纯业务逻辑，不关心调用方是谁。
 * Function Calling（tools.ts）和 MCP Server（mcp-server.ts）都复用这一层——
 * 这就是"工具能力服务化"的第一步：逻辑和协议解耦。
 */

export function queryChaptersData(fromChapterId: number, toChapterId?: number) {
  const to = toChapterId ?? fromChapterId;
  return chapterStats.filter((c) => c.chapterId >= fromChapterId && c.chapterId <= to);
}

export function analyzeTrendData(fromChapterId: number, toChapterId: number) {
  const list = chapterStats.filter((c) => c.chapterId >= fromChapterId && c.chapterId <= toChapterId);
  if (list.length === 0) return { error: '区间内无数据' };

  const byFinish = [...list].sort((a, b) => a.finishRate7d - b.finishRate7d);
  const dropFollow = list.filter((c) => c.netFollow7d < 0);
  const first = list[0];
  const last = list[list.length - 1];
  const readerTrend = ((last.readers7d - first.readers7d) / first.readers7d) * 100;

  return {
    lowestFinishRate: { chapter: byFinish[0].title, rate: byFinish[0].finishRate7d },
    highestFinishRate: { chapter: byFinish[byFinish.length - 1].title, rate: byFinish[byFinish.length - 1].finishRate7d },
    chaptersLosingFollowers: dropFollow.map((c) => ({ chapter: c.title, netFollow7d: c.netFollow7d })),
    readerChangePercent: Number(readerTrend.toFixed(1)),
  };
}

export function saveReportData(title: string, conclusions: string[], suggestions: string[]) {
  const reportId = `RPT-${Date.now().toString(36).toUpperCase()}`;
  // v2 可以写入数据库 / 生成文件
  console.error(`📄 报告已生成 [${reportId}]: ${title}`); // 注意：MCP stdio 模式下 stdout 是协议通道，日志必须走 stderr
  return { reportId, saved: true };
}
