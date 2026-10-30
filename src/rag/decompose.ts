import { generateText } from 'ai';
import { getClient } from './summarize.js';

/**
 * 查询分解（T4 大型书）：把复杂/全局问题拆成 2-3 个可独立检索的子问题，
 * 分别检索后合并精排——多跳问题（人物关系、跨卷情节）单次检索必然漏。
 * 快模型一次调用，失败回退为原始查询（分解是增强，不是依赖）。
 */

export async function decomposeQuery(question: string): Promise<string[]> {
  const result = await generateText({
    model: getClient()(process.env.MODEL_FAST || 'glm-4-flash'),
    system: `你是检索查询规划器。把用户问题拆解为 2-3 个可独立检索的子问题（每个子问题自包含、可直接用于语义检索）。
只输出 JSON 数组，格式：["子问题1","子问题2"]。不要任何其他内容。`,
    prompt: question,
    maxRetries: 2,
  });

  try {
    const match = result.text.match(/\[[\s\S]*\]/);
    if (match) {
      const arr = JSON.parse(match[0]) as unknown[];
      const sub = arr.filter((s): s is string => typeof s === 'string' && s.trim().length > 0).slice(0, 3);
      if (sub.length > 0) return sub;
    }
  } catch { /* 解析失败回退 */ }

  return [question];
}
