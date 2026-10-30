import { embed } from './embed.js';
import { rerank } from './rerank.js';
import { searchNovelChunks } from './store.js';
import { ragScope } from './context.js';
import { decomposeQuery } from './decompose.js';
import { retrieveLog } from '../logger.js';

/**
 * 统一检索入口：向量粗召回 → rerank 精排。
 * 所有调用方（Agent 工具 / 评测脚本）都走这里，保证评测测的就是线上真实链路。
 *
 * 降级策略：rerank API 挂了/限流时自动退回向量序——检索可用性优先于排序质量。
 */

/** 粗召回条数：给 rerank 留足候选（召回少了精排无米下锅） */
const CANDIDATES = 10;

export interface RetrievedChunk {
  level: number;
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
  // 游客请求只扫公开演示库（作用域由 HTTP 层通过 ALS 设置）
  const onlyPublic = ragScope.getStore()?.onlyPublic;
  const candidates = searchNovelChunks(vector, CANDIDATES, novelId, onlyPublic);
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
    retrieveLog.warn({ err: err instanceof Error ? err.message : String(err) }, 'rerank 失败，降级为向量序');
    return candidates.slice(0, topK).map((c) => ({ ...c, vectorScore: c.similarity, reranked: false }));
  }
}

/**
 * 多路检索（T4 查询分解）：问题 → 拆分子问题 → 逐个检索 → 合并去重 → 终排。
 * 多跳/全局问题单次检索必然漏，拆解后多路覆盖。仅 T4 启用，其余级别走单路。
 */
export async function retrieveMulti(query: string, topK = 3, novelId?: string): Promise<RetrievedChunk[]> {
  const scope = ragScope.getStore();
  if (scope?.tier !== 'T4') return retrieve(query, topK, novelId);

  let subQueries: string[] = [query];
  try {
    subQueries = await decomposeQuery(query);
  } catch (err) {
    retrieveLog.warn({ err: err instanceof Error ? err.message : String(err) }, '查询分解失败，回退单路');
  }

  // 逐子问题检索 + 按 text 去重（不同子查询可能命中同一块）
  const merged = new Map<string, RetrievedChunk>();
  for (const q of subQueries) {
    for (const r of await retrieve(q, topK, novelId)) {
      if (!merged.has(r.text)) merged.set(r.text, r);
    }
  }

  // 合并集大于 topK 时用 rerank 终排
  const list = [...merged.values()];
  if (list.length <= topK) return list;

  try {
    const docs = list.map((c) => `${c.novelTitle ?? ''} ${c.chapter}\n${c.text}`);
    const indices = await rerank(query, docs, topK);
    return indices.map((i) => ({ ...list[i], reranked: true }));
  } catch {
    return list.slice(0, topK);
  }
}
