import { generateText } from 'ai';
import { createOpenAICompatible, type OpenAICompatibleProvider } from '@ai-sdk/openai-compatible';

/**
 * 章节摘要生成（T3/T4 摘要层的数据源）：
 * - 用快模型逐章生成 ~300 字摘要（主要事件/出场人物/关键物品与伏笔）
 * - 章节原文超长时截断输入（摘要只需概况，不需要全文精读）
 * - 客户端懒加载：模块加载时 env 可能尚未由 dotenv 填充（import 顺序问题），
 *   必须在首次调用时才读取 process.env 并创建实例
 */

const SUMMARY_INPUT_CAP = 3000; // 单章原文超过此长度截断（摘要不需要全文精读）

let client: ReturnType<typeof createOpenAICompatible> | null = null;

export function getClient() {
  if (!client) {
    client = createOpenAICompatible({
      name: 'zhipu',
      baseURL: 'https://open.bigmodel.cn/api/paas/v4',
      apiKey: process.env.ZHIPU_API_KEY,
    });
  }
  return client;
}

export async function summarizeChapter(chapterLabel: string, chapterText: string): Promise<string> {
  const input = chapterText.length > SUMMARY_INPUT_CAP ? chapterText.slice(0, SUMMARY_INPUT_CAP) + '……（后文略）' : chapterText;

  const result = await generateText({
    model: getClient()(process.env.MODEL_FAST || 'glm-4-flash'),
    system: '你是网文编辑。用 300 字以内概括给定章节：主要事件、出场人物、关键物品与伏笔。只输出概括正文，不要开场白。',
    prompt: `章节标题：${chapterLabel}\n章节内容：\n${input}`,
    maxRetries: 3,
  });

  return result.text.trim();
}

/**
 * 批量章摘要：一次调用概括多章，用 <summary> 标记切分。
 * 为什么不逐章调用：T4 一本书几百章，串行单章调用要几十分钟——
 * 批量化把调用次数除以批大小，是免费模型限流下最有效的提速手段。
 * 解析失败（模型漏输出某章标记）时对缺失章节回退为逐章调用，保证完整性。
 */
export async function summarizeChapters(items: { label: string; text: string }[], inputCap = SUMMARY_INPUT_CAP): Promise<string[]> {
  const parts = items.map((it, i) => {
    const input = it.text.length > inputCap ? it.text.slice(0, inputCap) + '……（后文略）' : it.text;
    return `【第${i + 1}章】${it.label}\n${input}`;
  });

  const result = await generateText({
    model: getClient()(process.env.MODEL_FAST || 'glm-4-flash'),
    system: '你是网文编辑。输入包含多章内容，请为每一章分别输出 300 字以内的概括，内容涵盖：主要事件、出场人物、关键物品与伏笔。输出格式：每章一个 summary 标签块，形如 <summary idx="1">这里写第一章的实际概括内容</summary>，idx 从 1 按输入顺序递增。注意：标签内必须是该章的真实概括文字，禁止输出"概括正文"这类占位词，不要输出其他内容。',
    prompt: parts.join('\n\n'),
    maxRetries: 3,
  });

  const summaries = new Array<string>(items.length).fill('');
  const re = /<summary idx="(\d+)">([\s\S]*?)<\/summary>/g;
  for (const m of result.text.matchAll(re)) {
    const idx = Number(m[1]) - 1;
    if (idx >= 0 && idx < items.length) summaries[idx] = m[2].trim();
  }

  // 质量校验：缺失、过短或原样照抄占位词的，逐章重试兜底
  // （教训：格式示例里写过 "<summary idx="1">概括正文</summary>"，模型会原样抄占位词）
  await Promise.all(
    summaries.map(async (s, i) => {
      if (isPlaceholder(s)) summaries[i] = await summarizeChapter(items[i].label, items[i].text);
    }),
  );
  return summaries;
}

/** 占位/无效摘要判定：模型偷懒照抄格式示例时拦下来 */
function isPlaceholder(s: string): boolean {
  const t = s.trim();
  return !t || t.length < 30 || /^概括(正文)?$/.test(t);
}
