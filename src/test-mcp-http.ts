import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

/** HTTP 传输版 MCP 测试客户端：模拟远程宿主接入 */
async function main() {
  const url = process.env.MCP_HTTP_URL || 'http://localhost:3002/mcp';

  const client = new Client({ name: 'test-http-client', version: '0.1.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  console.log(`✅ 已通过 HTTP 连接 MCP Server: ${url}\n`);

  const tools = await client.listTools();
  console.log('📋 工具清单:', tools.tools.map((t) => t.name).join(', '), '\n');

  const result = await client.callTool({
    name: 'analyzeTrend',
    arguments: { fromChapterId: 3, toChapterId: 8 },
  });
  console.log('🔧 analyzeTrend(3, 8) 结果:');
  console.log((result.content as any)[0].text);

  await client.close();
}

main().catch((err) => {
  console.error('❌ 测试失败:', err.message);
  process.exit(1);
});
