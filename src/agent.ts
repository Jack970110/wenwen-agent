import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { streamText, stepCountIs, type ModelMessage } from 'ai';
import { allTools } from './tools.js';
import { listNovels } from './rag/store.js';

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
/**
 * Agent 的"大脑"：系统提示词决定它扮演什么角色、按什么流程工作。
 * 动态注入已入库小说清单——模型不知道库里有书，就不会对模糊问题触发检索。
 */
function buildSystemPrompt(): string {
  const novels = listNovels();
  const novelList = novels.length
    ? novels.map((n) => `《${n.title}》`).join('、')
    : '（暂无）';

  return `你是"问问"，一位小说分析与网文数据分析 Agent。

已入库小说：${novelList}

小说问答规则：
1. 用户的问题涉及人物、地点、物品、情节、伏笔等小说内容时——哪怕只是一个词（如"钥匙"）——必须先用 searchNovel 检索原文，再基于片段回答
2. 回答必须标注章节出处；检索片段里没有的书名、人名、情节一律不编造
3. 检索不到就如实说"小说中未找到相关内容"
4. 小说阅读数据相关的问题走数据分析工具，不要用 searchNovel

数据分析规则：
1. 分析阅读数据时先用 queryChapters 了解数据概况，需要结论时用 analyzeTrend 做分析
2. 分析完成后调用 generateReport 保存结构化结论

通用：回复简洁自然，重点突出`;
}

const SYSTEM_PROMPT = buildSystemPrompt();

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
