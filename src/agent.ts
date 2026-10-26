import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { streamText, stepCountIs, type ModelMessage } from 'ai';
import { allTools } from './tools.js';

/**
 * 智谱开放平台的接口兼容 OpenAI 格式，所以用 openai-compatible provider。
 * 知识点：国内主流模型平台（智谱/DeepSeek/千问/硅基流动）都兼容 OpenAI 协议，
 * 换模型 = 换 baseURL + apiKey + 模型名，业务代码零改动——这就是协议统一的value。
 */
const zhipu = createOpenAICompatible({
  name: 'zhipu',
  baseURL: 'https://open.bigmodel.cn/api/paas/v4',
  apiKey: process.env.ZHIPU_API_KEY,
});

/**
 * Agent 的"大脑"：系统提示词决定它扮演什么角色、按什么流程工作。
 */
const SYSTEM_PROMPT = `你是"问问"，一位小说分析与网文数据分析 Agent。

小说问答规则：
1. 回答小说内容相关问题时，必须先用 searchNovel 检索原文，基于检索到的片段回答
2. 引用内容时标注章节出处
3. 检索不到就如实说"小说中未找到相关内容"，不要编造情节

数据分析规则：
1. 分析阅读数据时先用 queryChapters 了解数据概况，需要结论时用 analyzeTrend 做分析
2. 分析完成后调用 generateReport 保存结构化结论

通用：
- 回复简洁自然，重点突出
- 数据和原文里没有的信息不要编造`;

/**
 * Agent Loop 的核心就是这一行 streamText：
 * - 模型输出文本 → 直接流式给用户
 * - 模型输出工具调用 → SDK 执行 execute → 把结果喂回模型 → 模型继续思考
 * - stopWhen 限制最多 8 步，防止模型无限循环调用工具（生产必配的护栏）
 */
export function runAgent(messages: ModelMessage[], abortSignal?: AbortSignal) {
  const result = streamText({
    model: zhipu('glm-4-flash'),
    system: SYSTEM_PROMPT,
    messages,
    abortSignal,
    maxRetries: 5, // 免费模型高峰期限流（429），多给几次退避重试的机会
    tools: allTools,
    stopWhen: stepCountIs(8),
  });

  return result;
}
