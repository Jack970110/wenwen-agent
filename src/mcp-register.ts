import { z } from 'zod';
import { queryChaptersData, analyzeTrendData, saveReportData } from './dataService.js';

/**
 * MCP 工具注册逻辑（stdio 与 HTTP 两种传输共享）。
 * 传输层决定"怎么通信"，这一层决定"提供什么能力"——又一次协议与逻辑解耦。
 */
export function registerWenwenTools(server: {
  registerTool: (name: string, config: any, handler: (args: any) => Promise<any>) => void;
}) {
  server.registerTool('queryChapters', {
    title: '查询章节数据',
    description: '查询小说章节的阅读数据（阅读人数、完读率、追更变化等）。可按章节区间查询。',
    inputSchema: {
      fromChapterId: z.number().int().describe('起始章节 id（含）'),
      toChapterId: z.number().int().optional().describe('结束章节 id（含），不传则只查起始那一章'),
    },
  }, async ({ fromChapterId, toChapterId }) => ({
    content: [{ type: 'text', text: JSON.stringify(queryChaptersData(fromChapterId, toChapterId), null, 2) }],
  }));

  server.registerTool('analyzeTrend', {
    title: '章节趋势分析',
    description: '对章节数据做趋势分析：完读率最低/最高的章节、阅读量变化趋势、追更净增为负的章节。',
    inputSchema: {
      fromChapterId: z.number().int().describe('起始章节 id（含）'),
      toChapterId: z.number().int().describe('结束章节 id（含）'),
    },
  }, async ({ fromChapterId, toChapterId }) => ({
    content: [{ type: 'text', text: JSON.stringify(analyzeTrendData(fromChapterId, toChapterId), null, 2) }],
  }));

  server.registerTool('generateReport', {
    title: '生成数据报告',
    description: '将分析结论保存为结构化数据报告，返回报告 id。',
    inputSchema: {
      title: z.string().describe('报告标题'),
      conclusions: z.array(z.string()).describe('结论列表，每条一句话'),
      suggestions: z.array(z.string()).describe('改进建议列表，每条一句话'),
    },
  }, async ({ title, conclusions, suggestions }) => ({
    content: [{ type: 'text', text: JSON.stringify(saveReportData(title, conclusions, suggestions), null, 2) }],
  }));
}
