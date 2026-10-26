/**
 * Rerank 精排：cross-encoder 对「问题 × 候选片段」逐对精读打分，
 * 比向量余弦相似度（双塔，各自编码后比对）准得多。
 * 用硅基流动免费的 BAAI/bge-reranker-v2-m3，Cohere 兼容接口。
 */

const BASE_URL = process.env.EMBEDDING_BASE_URL || 'https://api.siliconflow.cn/v1';
const MODEL = process.env.RERANK_MODEL || 'BAAI/bge-reranker-v2-m3';

/** 返回按相关度降序的候选下标（长度 = min(topK, documents.length)） */
export async function rerank(query: string, documents: string[], topK = 3): Promise<number[]> {
  if (documents.length === 0) return [];

  const apiKey = process.env.SILICONFLOW_API_KEY;
  if (!apiKey) throw new Error('未配置 SILICONFLOW_API_KEY');

  const res = await fetch(`${BASE_URL}/rerank`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, query, documents, top_n: topK, return_documents: false }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Rerank 请求失败 (${res.status}): ${body.slice(0, 200)}`);
  }

  const data = (await res.json()) as { results: { index: number; relevance_score: number }[] };
  return data.results.sort((a, b) => b.relevance_score - a.relevance_score).map((r) => r.index);
}
