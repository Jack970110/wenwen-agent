import 'dotenv/config';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { convertToModelMessages, type UIMessage } from 'ai';
import { runAgent } from './agent.js';

/**
 * CLI 交互入口。
 * 每轮对话：用户输入 → Agent（可能多步工具调用）→ 流式输出回复
 * 历史消息保留在 messages 里，所以 Agent 有多轮对话记忆。
 *
 * 流式工具调用过程也会打印出来（哪个工具、什么参数），
 * 这是面试可以讲的可观测性细节：Agent 的执行过程对用户透明。
 */
async function main() {
  if (!process.env.ZHIPU_API_KEY) {
    console.error('❌ 未配置 ZHIPU_API_KEY，请复制 .env.example 为 .env 并填入 key');
    process.exit(1);
  }

  console.log('问渠 Agent 已启动（输入 exit 退出）\n');
  const rl = createInterface({ input: stdin, output: stdout });
  const messages: UIMessage[] = [];

  while (true) {
    const input = await rl.question('你 > ');
    const text = input.trim();
    if (!text) continue;
    if (text === 'exit') break;

    messages.push({ role: 'user', parts: [{ type: 'text', text }], id: crypto.randomUUID() });

    process.stdout.write('问渠 > ');
    let full = '';
    try {
      const result = runAgent(await convertToModelMessages(messages));

      // 打印工具调用过程（可观测性）
      for await (const part of result.fullStream) {
        if (part.type === 'tool-call') {
          process.stdout.write(`\n  🔧 调用工具 ${part.toolName}(${JSON.stringify(part.input)})\n  `);
        }
        if (part.type === 'text-delta') {
          full += part.text;
          process.stdout.write(part.text);
        }
        // 工具执行报错也要打出来，不能静默吞掉
        if (part.type === 'tool-error') {
          process.stdout.write(`\n  ⚠️ 工具 ${part.toolName} 执行失败: ${part.error}\n  `);
        }
      }
      process.stdout.write('\n\n');
    } catch (err) {
      // 模型 API 层的错误（余额不足/限流/网络）在这里兜底，给用户友好提示
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('Insufficient Balance') || msg.includes('402')) {
        console.error('\n❌ 模型账户余额不足，请到对应平台充值后重试\n');
      } else if (msg.includes('rate') || msg.includes('429')) {
        console.error('\n⚠️ 请求过于频繁（限流），稍等几秒再试\n');
      } else {
        console.error(`\n❌ 请求失败: ${msg}\n`);
      }
      messages.pop(); // 失败的这轮不留在历史里，避免污染上下文
      continue;
    }

    messages.push({ role: 'assistant', parts: [{ type: 'text', text: full }], id: crypto.randomUUID() });
  }

  rl.close();
}

main();
