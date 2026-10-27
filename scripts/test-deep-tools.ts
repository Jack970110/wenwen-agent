import 'dotenv/config';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { generateText, stepCountIs } from 'ai';
import { allTools } from '../src/tools.js';

/** 诊断：Z1 非流式 + 工具调用是否正常 */
const zhipu = createOpenAICompatible({
  name: 'zhipu',
  baseURL: 'https://open.bigmodel.cn/api/paas/v4',
  apiKey: process.env.ZHIPU_API_KEY,
});

const result = await generateText({
  model: zhipu(process.env.MODEL_DEEP || 'glm-z1-flash'),
  system: '你是助手。涉及小说内容必须调用 searchNovel 检索。',
  messages: [{ role: 'user', content: '《绍宋》的主人公是谁？' }],
  tools: allTools,
  stopWhen: stepCountIs(4),
});

console.log('文本:', JSON.stringify(result.text.slice(0, 200)));
console.log('工具调用:', result.toolCalls.map((t) => `${t.toolName}(${JSON.stringify(t.input)})`));
console.log('步骤数:', result.steps.length);
