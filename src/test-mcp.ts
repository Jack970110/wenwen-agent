import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

/**
 * MCP 测试客户端：模拟宿主（CodeBuddy/Cursor）的角色，
 * spawn MCP Server 子进程并走完整协议流程：握手 → 列工具 → 调工具。
 * 不依赖任何宿主就能验证 Server 正确性。
 */
async function main() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', 'src/mcp-server.ts'],
  });

  const client = new Client({ name: 'test-client', version: '0.1.0' });
  await client.connect(transport);
  console.log('✅ 已连接 MCP Server\n');

  const tools = await client.listTools();
  console.log('📋 工具清单:', tools.tools.map((t) => t.name).join(', '), '\n');

  const result = await client.callTool({
    name: 'queryChapters',
    arguments: { fromChapterId: 3, toChapterId: 5 },
  });
  console.log('🔧 queryChapters(3, 5) 结果:');
  console.log((result.content as any)[0].text, '\n');

  const trend = await client.callTool({
    name: 'analyzeTrend',
    arguments: { fromChapterId: 1, toChapterId: 8 },
  });
  console.log('🔧 analyzeTrend(1, 8) 结果:');
  console.log((trend.content as any)[0].text);

  await client.close();
}

main().catch((err) => {
  console.error('❌ 测试失败:', err.message);
  process.exit(1);
});
