import { chunkNovel, type ChunkOptions, type NovelChunk } from './chunker.js';
import { embed } from './embed.js';
import { buildSummaryLayer } from './summaries.js';
import { contentHash, createNovel, deleteNovel, findNovelByContentHash, insertChunks, saveNovelMetaFromChunks, setNovelStatus } from './store.js';
import { determineTier } from './tier.js';
import { envPositive, mapPool } from './util.js';

/**
 * 异步入库任务队列（进程内实现）。
 *
 * 为什么不引 BullMQ/Redis：单机部署 + 任务密度低，进程内 Map 就是"对的复杂度"。
 * 已知边界：进程重启会丢任务状态（任务本身丢就丢了，重传即可）——这是有意识的取舍。
 * 多实例部署时才需要外部队列（v3b 上线要素的知识点）。
 *
 * T3/T4 摘要层：原文块（level 0）入库后，追加「摘要生成阶段」——
 * 逐章用快模型生成摘要（level 1），T4 再每 30 章聚合生成段落摘要（level 2）。
 * 摘要也向量化入库，与原文块同池检索，rerank 统一定序。
 */

export type IngestStage = 'vectorizing' | 'summarizing';

export interface IngestJob {
  id: string;
  title: string;
  status: 'processing' | 'done' | 'error';
  /** 当前阶段：向量化原文块 / 生成摘要层 */
  stage?: IngestStage;
  /** 已向量化的块数 / 总块数 */
  embedded: number;
  total: number;
  novelId?: string;
  error?: string;
}

const jobs = new Map<string, IngestJob>();

/** 并发入库上限：任务并行会让 embedding/摘要 API 的 429 退避互相踩踏，串行是单机部署的最优解。env 可覆盖（多 key 场景放宽） */
const MAX_CONCURRENT = (() => {
  const n = Number(process.env.INGEST_MAX_CONCURRENT);
  return Number.isInteger(n) && n > 0 ? n : 1;
})();

export function startIngestJob(title: string, rawText: string, chunkOpts: ChunkOptions = {}): string {
  const running = [...jobs.values()].filter((j) => j.status === 'processing').length;
  if (running >= MAX_CONCURRENT) {
    throw new Error(`已有 ${running} 个文档正在入库（向量化是 API 密集操作，并发会导致限流），请等当前任务完成后再上传`);
  }
  const id = crypto.randomUUID();
  const job: IngestJob = { id, title, status: 'processing', embedded: 0, total: 0 };
  jobs.set(id, job);
  // fire-and-forget：后台跑，状态写回 job，路由层轮询读取
  void runJob(job, rawText, chunkOpts);
  return id;
}

async function runJob(job: IngestJob, rawText: string, chunkOpts: ChunkOptions) {
  try {
    // 指纹查重：同内容文件秒拒（在切块之前，失败成本为零）
    const hash = contentHash(rawText);
    const dup = findNovelByContentHash(hash);
    if (dup) {
      job.status = 'error';
      job.error = `内容与已入库的《${dup.title}》重复，无需重复入库`;
      return;
    }

    const chunks = chunkNovel(rawText, chunkOpts);
    if (chunks.length === 0) {
      throw new Error('未解析到有效内容（需包含"第X章"等章节标题）');
    }
    job.total = chunks.length;

    // 定级：T1 微型书不走向量检索（全量塞上下文），跳过向量化省时省钱
    const tier = determineTier(chunks.reduce((s, c) => s + c.text.length, 0));

    if (tier === 'T1') {
      const novelId = createNovel(job.title, 'admin', rawText, hash);
      job.novelId = novelId;
      saveNovelMetaFromChunks(novelId, chunks);
      setNovelStatus(novelId, 'ready'); // T1 秒完成，直接可用
      job.embedded = chunks.length;
      job.status = 'done';
      return;
    }

    const novelId = createNovel(job.title, 'admin', undefined, hash);
    job.novelId = novelId;
    setNovelStatus(novelId, 'ingesting'); // 列表可见但标记"入库中"，完成后转 ready

    // 阶段 1：原文块向量化（level 0）
    // 并发批处理：embedding API 并发上限比 LLM 宽松，多路并行把长篇的
    // 向量化从十几分钟压到几分钟（EMBED_CONCURRENCY 可调，默认 4）
    job.stage = 'vectorizing';
    const BATCH = 16;
    const EMBED_CONCURRENCY = envPositive('EMBED_CONCURRENCY', 4);
    const withVectors: (NovelChunk & { vector: number[] })[] = [];
    const embedBatches: NovelChunk[][] = [];
    for (let i = 0; i < chunks.length; i += BATCH) {
      embedBatches.push(chunks.slice(i, i + BATCH));
    }
    let embeddedCount = 0;
    await mapPool(embedBatches, EMBED_CONCURRENCY, async (batch) => {
      const vectors = await embed(batch.map((b) => b.text));
      batch.forEach((b, j) => withVectors.push({ ...b, vector: vectors[j] }));
      embeddedCount += batch.length;
      job.embedded = Math.min(embeddedCount, chunks.length);
    });
    insertChunks(novelId, withVectors, 0);

    // 阶段 2（T3/T4）：摘要层生成 + 向量化（level 1 章摘要 / level 2 段落摘要）
    if (tier === 'T3' || tier === 'T4') {
      job.stage = 'summarizing';
      job.total = chunks.length;
      await buildSummaryLayer(novelId, chunks, tier, (done, total) => {
        job.embedded = done;
        job.total = total;
      });
    }

    saveNovelMetaFromChunks(novelId, chunks);
    setNovelStatus(novelId, 'ready');
    job.status = 'done';
  } catch (err) {
    // 失败回滚：不留半截数据
    if (job.novelId) deleteNovel(job.novelId);
    job.status = 'error';
    job.error = err instanceof Error ? err.message : String(err);
  }
}

export function getJob(id: string): IngestJob | undefined {
  return jobs.get(id);
}
