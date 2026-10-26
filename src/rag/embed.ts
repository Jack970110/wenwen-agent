/**
 * Embedding 客户端：硅基流动 bge-m3（免费），OpenAI 兼容接口。
 * 配置全部走 .env，换供应商不改代码。
 */

const BASE_URL = process.env.EMBEDDING_BASE_URL || 'https://api.siliconflow.cn/v1';
const MODEL = process.env.EMBEDDING_MODEL || 'BAAI/bge-m3';

export async function embed(texts: string[]): Promise<number[][]> {
  const apiKey = process.env.SILICONFLOW_API_KEY;
  if (!apiKey) throw new Error('未配置 SILICONFLOW_API_KEY（siliconflow.cn 注册获取，免费）');

  const res = await fetch(`${BASE_URL}/embeddings`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model: MODEL, input: texts, encoding_format: 'float' }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Embedding 请求失败 (${res.status}): ${body.slice(0, 200)}`);
  }

  const data = (await res.json()) as { data: { embedding: number[]; index: number }[] };
  // 按 index 排序还原输入顺序
  return data.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
}

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
