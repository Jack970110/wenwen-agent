#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { queryChaptersData, analyzeTrendData, saveReportData } from './dataService.js';

/**
 * v2b：MCP Server（stdio 传输）
 *
 * 和 Function Calling 的区别：
 * - Function Calling：工具是 Agent 进程内的函数，AI SDK 直接调用
 * - MCP：工具是独立进程通过标准协议暴露的能力，任何宿主（CodeBuddy/Cursor/你自己的 Agent）都能接入
 *
 * stdio 传输的关键纪律：stdout 是协议通道，一个 console.log 都不能打，
 * 否则会污染 JSON-RPC 消息流。日志一律走 stderr。
 */

const server = new McpServer({
  name: 'wenwen-data',
  version: '0.1.0',
});

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

// stdio 传输：从标准输入读 JSON-RPC 请求，向标准输出写响应
await server.connect(new StdioServerTransport());
// 注意：connect 后进程要保持存活等待宿主指令，不能加 console.log 或主动退出
