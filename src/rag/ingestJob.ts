import { chunkNovel, type NovelChunk } from './chunker.js';
import { embed } from './embed.js';
import { createNovel, deleteNovel, insertChunks, saveNovelMetaFromChunks } from './store.js';

/**
 * 异步入库任务队列（进程内实现）。
 *
 * 为什么不引 BullMQ/Redis：单机部署 + 任务密度低，进程内 Map 就是"对的复杂度"。
 * 已知边界：进程重启会丢任务状态（任务本身丢就丢了，重传即可）——这是有意识的取舍。
 * 多实例部署时才需要外部队列（v3b 上线要素的知识点）。
 */

export interface IngestJob {
  id: string;
  title: string;
  status: 'processing' | 'done' | 'error';
  /** 已向量化的块数 / 总块数 */
  embedded: number;
  total: number;
  novelId?: string;
  error?: string;
}

const jobs = new Map<string, IngestJob>();

export function startIngestJob(title: string, rawText: string): string {
  const id = crypto.randomUUID();
  const job: IngestJob = { id, title, status: 'processing', embedded: 0, total: 0 };
  jobs.set(id, job);
  // fire-and-forget：后台跑，状态写回 job，路由层轮询读取
  void runJob(job, rawText);
  return id;
}

async function runJob(job: IngestJob, rawText: string) {
  try {
    const chunks = chunkNovel(rawText);
    if (chunks.length === 0) {
      throw new Error('未解析到有效内容（需包含"第X章"等章节标题）');
    }
    job.total = chunks.length;

    const novelId = createNovel(job.title);
    job.novelId = novelId;

    // 批量向量化，每批完成更新进度
    const BATCH = 16;
    const withVectors: (NovelChunk & { vector: number[] })[] = [];
    for (let i = 0; i < chunks.length; i += BATCH) {
      const batch = chunks.slice(i, i + BATCH);
      const vectors = await embed(batch.map((b) => b.text));
      batch.forEach((b, j) => withVectors.push({ ...b, vector: vectors[j] }));
      job.embedded = Math.min(i + BATCH, chunks.length);
    }

    insertChunks(novelId, withVectors);
    saveNovelMetaFromChunks(novelId, chunks);

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
