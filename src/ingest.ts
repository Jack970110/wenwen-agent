#!/usr/bin/env node
/**
 * 小说入库管道（CLI）：
 *   npm run ingest -- <novel.txt> <小说名>
 *
 * 流程：读取 txt → 切块 → 批量 embedding → 存入向量库
 */
import { readFileSync } from 'node:fs';
import { chunkNovel, type NovelChunk } from './rag/chunker.js';
import { embed } from './rag/embed.js';
import { buildSummaryLayer } from './rag/summaries.js';
import { contentHash, createNovel, deleteNovel, findNovelByContentHash, insertChunks, listNovels, saveNovelMetaFromChunks, setNovelStatus } from './rag/store.js';
import { determineTier } from './rag/tier.js';
import { envPositive, mapPool } from './rag/util.js';
import 'dotenv/config';

async function main() {
  const [file, title] = process.argv.slice(2);
  if (!file || !title) {
    console.error('用法: npm run ingest -- <novel.txt> <小说名> [--chunk-size N] [--chunk-min N] [--chunk-overlap N]');
    process.exit(1);
  }
  // 可选切块参数（不传走默认 400/80/0）
  const flag = (name: string): number | undefined => {
    const i = process.argv.indexOf(name);
    if (i === -1) return undefined;
    const n = Number(process.argv[i + 1]);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };
  const chunkOpts = {
    targetSize: flag('--chunk-size'),
    minSize: flag('--chunk-min'),
    overlap: flag('--chunk-overlap'),
  };

  const raw = readFileSync(file, 'utf-8');
  const hash = contentHash(raw);
  const dup = findNovelByContentHash(hash);
  if (dup) {
    console.error(`❌ 该文件内容已入库（《${dup.title}》），无需重复入库`);
    process.exit(1);
  }
  const chunks = chunkNovel(raw, chunkOpts);
  console.log(`📖 ${title}: 共 ${chunks.length} 个文本块`);

  const tier = determineTier(chunks.reduce((s, c) => s + c.text.length, 0));
  console.log(`📊 定级: ${tier}`);

  // 失败回滚与 Web 异步路径一致：入库中途失败不留孤儿数据
  let novelId = '';
  try {
    if (tier === 'T1') {
      // 微型书：全量塞上下文，跳过向量化
      novelId = createNovel(title, 'admin', raw, hash);
      setNovelStatus(novelId, 'ready'); // T1 即存即用
      insertChunks(novelId, []); // T1 无向量块（不插入任何行）
      saveNovelMetaFromChunks(novelId, chunks);
      console.log(`✅ 入库完成（T1 全文模式，免向量化），novelId=${novelId}`);
      console.log('已有小说:', listNovels('admin').map((n: any) => `${n.title}(${n.chunkCount}块)`).join(', '));
      return;
    }

    // 批量 embedding（每批 16 条，避免超请求体和限流）+ 并发池提速
    const BATCH = 16;
    const EMBED_CONCURRENCY = envPositive('EMBED_CONCURRENCY', 4);
    const withVectors: (NovelChunk & { vector: number[] })[] = [];
    const embedBatches: NovelChunk[][] = [];
    for (let i = 0; i < chunks.length; i += BATCH) {
      embedBatches.push(chunks.slice(i, i + BATCH));
    }
    let embeddedCount = 0;
    await mapPool(embedBatches, EMBED_CONCURRENCY, async (batch) => {
      const vectors = await embed(batch.map((c) => c.text));
      batch.forEach((c, j) => withVectors.push({ ...c, vector: vectors[j] }));
      embeddedCount += batch.length;
      console.log(`  已向量化 ${Math.min(embeddedCount, chunks.length)}/${chunks.length}`);
    });

    novelId = createNovel(title, 'admin', undefined, hash);
    setNovelStatus(novelId, 'ingesting');
    insertChunks(novelId, withVectors);

    // 摘要层（T3/T4）：逐章 LLM 摘要 + 向量化入库（level 1/2）
    if (tier === 'T3' || tier === 'T4') {
      console.log('📝 生成章摘要…');
      await buildSummaryLayer(novelId, chunks, tier, (done, total) => {
        process.stdout.write(`\r  摘要 ${done}/${total}`);
      });
      process.stdout.write('\n');
    }

    saveNovelMetaFromChunks(novelId, chunks); // 结构元数据：统计类问题的数据源（之前漏了这步导致"多少章"答不出）
    setNovelStatus(novelId, 'ready');
    console.log(`✅ 入库完成，novelId=${novelId}`);
  } catch (err) {
    if (novelId) deleteNovel(novelId); // 失败回滚
    throw err;
  }
  console.log('已有小说:', listNovels('admin').map((n: any) => `${n.title}(${n.chunkCount}块)`).join(', '));
}

main().catch((err) => {
  console.error('❌ 入库失败:', err.message);
  process.exit(1);
});
