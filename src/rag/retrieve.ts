import { embed } from './embed.js';
import { rerank } from './rerank.js';
import { searchNovelChunks } from './store.js';

/**
 * 统一检索入口：向量粗召回 → rerank 精排。
 * 所有调用方（Agent 工具 / 评测脚本）都走这里，保证评测测的就是线上真实链路。
 *
 * 降级策略：rerank API 挂了/限流时自动退回向量序——检索可用性优先于排序质量。
 */

/** 粗召回条数：给 rerank 留足候选（召回少了精排无米下锅） */
const CANDIDATES = 10;

export interface RetrievedChunk {
  novelTitle?: string;
  chapter: string;
  text: string;
  /** 向量相似度（rerank 前的原始分，用于对比调试） */
  vectorScore: number;
  /** rerank 相关度分（0~1，越高越相关；降级时无此字段） */
  rerankScore?: number;
  reranked: boolean;
}

export async function retrieve(query: string, topK = 3, novelId?: string): Promise<RetrievedChunk[]> {
  const [vector] = await embed([query]);
  const candidates = searchNovelChunks(vector, CANDIDATES, novelId);
  if (candidates.length === 0) return [];

  try {
    const docs = candidates.map((c) => `${c.novelTitle} ${c.chapter}\n${c.text}`);
    const indices = await rerank(query, docs, topK);
    return indices.map((i) => ({
      ...candidates[i],
      vectorScore: candidates[i].similarity,
      reranked: true,
    }));
  } catch (err) {
    // 降级：rerank 挂了不阻断检索，退回向量序
    console.error(`[retrieve] rerank 失败，降级为向量序: ${err instanceof Error ? err.message : err}`);
    return candidates.slice(0, topK).map((c) => ({ ...c, vectorScore: c.similarity, reranked: false }));
  }
}
