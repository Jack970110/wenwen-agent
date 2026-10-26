import 'dotenv/config';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { streamText } from 'ai';

const zhipu = createOpenAICompatible({
  name: 'zhipu',
  baseURL: 'https://open.bigmodel.cn/api/paas/v4',
  apiKey: process.env.ZHIPU_API_KEY,
});

// 模拟阶段2：带长上下文
const context = Array.from({length: 6}, (_, i) => `[检索结果${i}]\n第三章 地窖：座钟的机芯后面有黄铜钥匙...`.repeat(30)).join('\n\n');
const result = streamText({
  model: zhipu('glm-z1-flash'),
  system: '你是深度分析助手，基于检索资料深度思考后回答。',
  messages: [
    { role: 'user', content: '钥匙藏在哪里？为什么？' },
    { role: 'assistant', content: `[已完成的检索资料]\n${context}` },
    { role: 'user', content: '请深度思考后回答。' },
  ],
  maxRetries: 5,
});

const start = Date.now();
let n = 0;
for await (const part of result.fullStream) {
  if (part.type === 'text-delta' || part.type === 'reasoning-delta') {
    n++;
    const t = (Date.now() - start) / 1000;
    if (n <= 3 || n % 50 === 0) console.log(`[${t.toFixed(1)}s] ${part.type}#${n}`);
  } else {
    const t = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`[${t}s] PART: ${part.type}`);
  }
}
console.log(`--- delta 总数 ${n}，总耗时 ${((Date.now()-start)/1000).toFixed(1)}s ---`);
