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
 * 聚焦小说信息：由请求层解析（含体量级别），T1 时携带全文供注入
 */
export interface FocusInfo {
  title: string;
  tier: string;
  fullText: string | null;
  /** 全书梗概（摘要层顶层产物）：全书级问题的答案锚点，聚焦时注入 */
  bookSummary?: string;
}

/**
 * Agent 的"大脑"：系统提示词决定它扮演什么角色、按什么流程工作。
 * 动态部分：已入库小说清单（让模型知道可检索什么）+ 聚焦小说（前端选择器传入）。
 */
function buildSystemPrompt(focus?: FocusInfo): string {
  const novels = listNovels('admin');
  const novelList = novels.length
    ? novels
        .map((n: any) => {
          let scale = '';
          try {
            const meta = n.meta ? JSON.parse(n.meta) : null;
            if (meta?.totalChapters) {
              const wan = Math.round(meta.totalChars / 10000);
              scale = meta.structureType === 'section'
                ? `（${meta.totalChapters}段/${wan}万字，无章节结构的文档）`
                : `（${meta.totalChapters}章/${wan}万字）`;
            }
          } catch { /* meta 解析失败不影响列表 */ }
          return `《${n.title}》${scale}`;
        })
        .join('、')
    : '（暂无）';

  let focusLine = '';
  if (focus?.tier === 'T1' && focus.fullText) {
    // T1 微型书：全文已注入，检索工具对该书无意义
    focusLine = `\n本次会话聚焦微型文档《${focus.title}》，其全文附在提示词末尾——涉及该书内容直接基于全文回答，不要调用 searchNovel。`;
  } else if (focus) {
    focusLine = `\n本次会话默认聚焦文档：《${focus.title}》——涉及该书时 searchNovel 的 novelTitle 传 "${focus.title}"。但用户明确提到其他文档名时，以用户指定的为准（novelTitle 传用户点名的文档）；用户没有点名时，默认检索聚焦文档。`;
  }

  const fullTextSection = focus?.tier === 'T1' && focus.fullText
    ? `\n\n=====《${focus.title}》全文 =====\n${focus.fullText}\n===== 全文结束 =====`
    : '';

  // 全书梗概注入：全书级问题（讲了什么/主线/结局）在向量检索里没有天然命中物，
  // 梗概作为背景知识直接进提示词，模型回答整体性问题时以此为基础
  const bookSummarySection = focus?.bookSummary
    ? `\n\n=====《${focus.title}》全书梗概 =====\n${focus.bookSummary}\n===== 梗概结束 =====（回答该书的故事主线、整体评价类问题时优先以此为背景，细节仍以检索结果为准）`
    : '';

  return `你是"问渠"，一位知识库问答与网文数据分析 Agent。名字取自"问渠那得清如许，为有源头活水来"——你的职责是从知识库源头中取材，给出清澈有据的回答。

已入库知识：${novelList}${focusLine}

知识库问答规则：
1. 用户的问题涉及知识库中的事实性内容（人物、情节、概念、条款、数据点等）时——哪怕只是一个词——必须先用 searchNovel 检索原文，再基于片段回答（聚焦文档为全文注入模式时除外，直接基于全文回答）
2. 用户指定了某个文档、或已锁定聚焦文档时，searchNovel 传入对应 novelTitle；不确定是哪份文档就全库检索，根据返回片段的 novelTitle 判断
3. 检索结果可能包含【章/段摘要】（概括）与原文片段（细节）：全局/结构性问题优先用摘要，细节问题以原文为准；回答时标注文档名和章节/段落出处
4. 回答必须**自己提炼归纳**，用一两句话直接给出答案，禁止大段照抄检索原文
5. 检索片段里没有的书名、人名、概念一律不编造
6. 检索不到就如实说"知识库中未找到相关内容"
7. 网文阅读数据相关的问题走数据分析工具，不要用 searchNovel

数据分析规则：
1. 分析阅读数据时先用 queryChapters 了解数据概况，需要结论时用 analyzeTrend 做分析
2. 分析完成后调用 generateReport 保存结构化结论

通用：回复简洁自然，重点突出${fullTextSection}${bookSummarySection}`;
}

/**
 * 模型路由：快模型做默认（响应速度优先），深度模型按需启用（推理质量优先）。
 * 模型名进配置，A/B 对比和供应商切换不改代码。
 */
const MODEL_FAST = process.env.MODEL_FAST || 'glm-4-flash';
const MODEL_DEEP = process.env.MODEL_DEEP || 'glm-z1-flash';

/**
 * Agent Loop 的核心就是这一行 streamText：
 * - 模型输出文本 → 直接流式给用户
 * - 模型输出工具调用 → SDK 执行 execute → 把结果喂回模型 → 模型继续思考
 * - stopWhen 限制最多 8 步，防止模型无限循环调用工具（生产必配的护栏）
 */
export function runAgent(
  messages: ModelMessage[],
  abortSignal?: AbortSignal,
  opts: { deep?: boolean; retrievalOnly?: boolean; focus?: FocusInfo } = {},
) {
  const result = streamText({
    model: zhipu(opts.deep ? MODEL_DEEP : MODEL_FAST),
    system: buildSystemPrompt(opts.focus),
    messages,
    abortSignal,
    maxRetries: 5, // 免费模型高峰期限流（429），多给几次退避重试的机会
    tools: allTools,
    // retrievalOnly：只跑第一轮（模型发起工具调用 + SDK 执行工具）就停，
    // 不让模型生成会被丢弃的回答——两阶段深度模式的阶段 1 用
    stopWhen: opts.retrievalOnly ? stepCountIs(1) : stepCountIs(8),
  });

  return result;
}
