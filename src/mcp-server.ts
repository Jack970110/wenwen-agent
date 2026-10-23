#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerWenwenTools } from './mcp-register.js';

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

// 工具注册逻辑在 mcp-register.ts，与 HTTP 传输版本共享
registerWenwenTools(server);

// stdio 传输：从标准输入读 JSON-RPC 请求，向标准输出写响应
await server.connect(new StdioServerTransport());
// 注意：connect 后进程要保持存活等待宿主指令，不能加 console.log 或主动退出
