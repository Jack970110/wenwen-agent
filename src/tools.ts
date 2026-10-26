import { tool } from 'ai';
import { z } from 'zod';
import { queryChaptersData, analyzeTrendData, saveReportData } from './dataService.js';
import { embed } from './rag/embed.js';
import { getNovelByTitle, listNovels, searchNovelChunks } from './rag/store.js';

/**
 * 工具（Function Calling）是 Agent 的"手"：
 * 模型只决定"调用哪个工具、传什么参数"，真正的执行在你写的 execute 函数里。
 *
 * inputSchema 用 zod 定义参数：AI SDK 转成 JSON Schema 给模型看，
 * 运行时也会校验，不合法就不会执行。
 *
 * v2b 起：执行逻辑收敛到 dataService.js，本文件只保留协议适配层
 * （AI SDK 的 tool 包装）。同一份逻辑同时暴露给 MCP Server。
 */

/** 工具 1：查询章节数据 */
export const queryChapters = tool({
  description: '查询小说章节的阅读数据（阅读人数、完读率、追更变化等）。可按章节区间查询，不传区间则返回全部章节。',
  inputSchema: z.object({
    fromChapterId: z.number().int().describe('起始章节 id（含）'),
    toChapterId: z.number().int().optional().describe('结束章节 id（含），不传则只查起始那一章'),
  }),
  execute: async ({ fromChapterId, toChapterId }) =>
    queryChaptersData(fromChapterId, toChapterId),
});

/** 工具 2：趋势分析（纯计算，展示"工具可以是确定性代码"） */
export const analyzeTrend = tool({
  description: '对章节数据做趋势分析：找出完读率最低/最高的章节、阅读量变化趋势、追更净增为负的章节。',
  inputSchema: z.object({
    fromChapterId: z.number().int().describe('起始章节 id（含）'),
    toChapterId: z.number().int().describe('结束章节 id（含）'),
  }),
  execute: async ({ fromChapterId, toChapterId }) =>
    analyzeTrendData(fromChapterId, toChapterId),
});

/** 工具 3：生成结构化报告（把分析结果落成 JSON 报告，模拟"交付物"） */
export const generateReport = tool({
  description: '将分析结论保存为结构化数据报告，返回报告 id。分析完成后应调用此工具输出最终结论。',
  inputSchema: z.object({
    title: z.string().describe('报告标题'),
    conclusions: z.array(z.string()).describe('结论列表，每条一句话'),
    suggestions: z.array(z.string()).describe('改进建议列表，每条一句话'),
  }),
  execute: async ({ title, conclusions, suggestions }) =>
    saveReportData(title, conclusions, suggestions),
});

/** 工具 4：小说语义检索（RAG）——回答基于检索到的原文片段 */
export const searchNovel = tool({
  description: '在已入库的小说中做语义检索，返回与问题最相关的原文片段（含书名和章节出处）。用户问题涉及人物、地点、物品、情节等内容时必须先调用此工具。',
  inputSchema: z.object({
    query: z.string().describe('检索问题，如"主角在哪里发现了日记"'),
    novelTitle: z.string().optional().describe('小说名。用户指定了某本书、或上下文明确在聊某本书时传入；未指定则全库检索'),
    topK: z.number().int().min(1).max(10).optional().describe('返回片段数，默认 3'),
  }),
  execute: async ({ query, novelTitle, topK }) => {
    // 按书名解析 novelId：书名不存在时明确报错，防止模型幻觉出书名后静默全库检索
    let novelId: string | undefined;
    if (novelTitle) {
      const novel = getNovelByTitle(novelTitle);
      if (!novel) return { message: `书库中没有《${novelTitle}》这本小说`, available: listNovels().map((n) => n.title) };
      novelId = novel.id;
    }
    const [vector] = await embed([query]);
    const results = searchNovelChunks(vector, topK ?? 3, novelId);
    return results.length ? results : { message: '未检索到相关内容' };
  },
});

export const allTools = { queryChapters, analyzeTrend, generateReport, searchNovel };
