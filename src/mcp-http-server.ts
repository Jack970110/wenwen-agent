#!/usr/bin/env node
import http from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { registerWenwenTools } from './mcp-register.js';

/**
 * v2b 进阶：MCP Server 的 HTTP（Streamable HTTP）传输版本。
 *
 * stdio vs HTTP 的本质区别：
 * - stdio：宿主拉起本地子进程，进程即服务——只有本机能用
 * - HTTP：你自己部署常驻服务，任何能访问到 URL 的宿主都能接入——可团队共享
 *
 * 无状态模式（sessionIdGenerator: undefined）的官方姿势：
 * 每个请求新建 McpServer + Transport 实例，请求结束即销毁。
 * 不能全局共享一个 transport——initialize 状态会被第一个请求吃掉，后续全 500。
 * 无请求状态也意味着可以随意水平扩展，和"会话状态放哪"是同一个架构题。
 */

const httpServer = http.createServer(async (req, res) => {
  // 只接受 POST /mcp；无状态模式不支持 GET(SSE 流) 和 DELETE(会话终止)
  if (req.method !== 'POST' || req.url !== '/mcp') {
    res.writeHead(405, { Allow: 'POST /mcp' }).end();
    return;
  }

  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);

  // 每请求一套实例（无状态模式标准写法）
  const server = new McpServer({ name: 'wenwen-data', version: '0.1.0' });
  registerWenwenTools(server);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => {
    transport.close();
    server.close();
  });
  await server.connect(transport);

  try {
    await transport.handleRequest(req, res, JSON.parse(Buffer.concat(chunks).toString('utf8')));
  } catch (err) {
    if (!res.headersSent) {
      res.writeHead(500).end(JSON.stringify({ error: err instanceof Error ? err.message : 'internal error' }));
    }
  }
});

const port = Number(process.env.MCP_HTTP_PORT) || 3002;
httpServer.listen(port, () => {
  console.error(`✅ wenwen-data MCP Server (HTTP) 已启动: http://localhost:${port}/mcp`);
});
