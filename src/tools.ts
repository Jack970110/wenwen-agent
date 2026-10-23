import { tool } from 'ai';
import { z } from 'zod';
import { chapterStats } from './mockData.js';

/**
 * 工具（Function Calling）是 Agent 的"手"：
 * 模型自己不会查数据，它只能决定"调用哪个工具、传什么参数"，
 * 真正的执行在你写的 execute 函数里——这就是"模型编排 + 代码执行"的核心分工。
 *
 * inputSchema 用 zod 定义参数：AI SDK 会把它转成 JSON Schema 给模型看，
 * 模型据此生成符合约束的参数，运行时 SDK 也会校验，不合法就不会执行。
 */

/** 工具 1：查询章节数据 */
export const queryChapters = tool({
  description: '查询小说章节的阅读数据（阅读人数、完读率、追更变化等）。可按章节区间查询，不传区间则返回全部章节。',
  inputSchema: z.object({
    fromChapterId: z.number().int().describe('起始章节 id（含）'),
    toChapterId: z.number().int().optional().describe('结束章节 id（含），不传则只查起始那一章'),
  }),
  execute: async ({ fromChapterId, toChapterId }) => {
    const to = toChapterId ?? fromChapterId;
    return chapterStats.filter((c) => c.chapterId >= fromChapterId && c.chapterId <= to);
  },
});

/** 工具 2：趋势分析（纯计算，展示"工具可以是确定性代码"） */
export const analyzeTrend = tool({
  description: '对章节数据做趋势分析：找出完读率最低/最高的章节、阅读量变化趋势、追更净增为负的章节。',
  inputSchema: z.object({
    fromChapterId: z.number().int().describe('起始章节 id（含）'),
    toChapterId: z.number().int().describe('结束章节 id（含）'),
  }),
  execute: async ({ fromChapterId, toChapterId }) => {
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
  },
});

/** 工具 3：生成结构化报告（把分析结果落成 JSON 报告，模拟"交付物"） */
export const generateReport = tool({
  description: '将分析结论保存为结构化数据报告，返回报告 id。分析完成后应调用此工具输出最终结论。',
  inputSchema: z.object({
    title: z.string().describe('报告标题'),
    conclusions: z.array(z.string()).describe('结论列表，每条一句话'),
    suggestions: z.array(z.string()).describe('改进建议列表，每条一句话'),
  }),
  execute: async ({ title, conclusions, suggestions }) => {
    const reportId = `RPT-${Date.now().toString(36).toUpperCase()}`;
    // v2 这里可以写入数据库 / 生成文件
    console.log(`\n📄 报告已生成 [${reportId}]: ${title}`);
    return { reportId, saved: true };
  },
});

export const allTools = { queryChapters, analyzeTrend, generateReport };
