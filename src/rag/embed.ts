/**
 * Embedding 客户端：硅基流动 bge-m3（免费），OpenAI 兼容接口。
 * 配置全部走 .env，换供应商不改代码。
 */

const BASE_URL = process.env.EMBEDDING_BASE_URL || 'https://api.siliconflow.cn/v1';
const MODEL = process.env.EMBEDDING_MODEL || 'BAAI/bge-m3';

export async function embed(texts: string[]): Promise<number[][]> {
  const apiKey = process.env.SILICONFLOW_API_KEY;
  if (!apiKey) throw new Error('未配置 SILICONFLOW_API_KEY（siliconflow.cn 注册获取，免费）');

  const body = JSON.stringify({ model: MODEL, input: texts, encoding_format: 'float' });

  // 免费档有限流（429），大文件入库几百次请求必然偶尔撞上：
  // 指数退避重试 4 次（1s/2s/4s/8s），重试期间任务进度不回滚
  let lastError: Error = new Error('unknown');
  for (let attempt = 0; attempt <= 4; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 1000 * 2 ** (attempt - 1)));

    const res = await fetch(`${BASE_URL}/embeddings`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body,
    });

    if (res.ok) {
      const data = (await res.json()) as { data: { embedding: number[]; index: number }[] };
      // 按 index 排序还原输入顺序
      return data.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
    }

    const errBody = await res.text();
    lastError = new Error(`Embedding 请求失败 (${res.status}): ${errBody.slice(0, 200)}`);
    // 只有 429/5xx 值得重试；401 余额类错误直接失败
    if (res.status !== 429 && res.status < 500) throw lastError;
  }
  throw lastError;
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
