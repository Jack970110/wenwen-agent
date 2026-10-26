#!/usr/bin/env node
/**
 * 小说入库管道（CLI）：
 *   npm run ingest -- <novel.txt> <小说名>
 *
 * 流程：读取 txt → 切块 → 批量 embedding → 存入向量库
 */
import { readFileSync } from 'node:fs';
import { chunkNovel } from './rag/chunker.js';
import { embed } from './rag/embed.js';
import { createNovel, insertChunks, listNovels } from './rag/store.js';
import 'dotenv/config';

async function main() {
  const [file, title] = process.argv.slice(2);
  if (!file || !title) {
    console.error('用法: npm run ingest -- <novel.txt> <小说名>');
    process.exit(1);
  }

  const raw = readFileSync(file, 'utf-8');
  const chunks = chunkNovel(raw);
  console.log(`📖 ${title}: 共 ${chunks.length} 个文本块`);

  // 批量 embedding（每批 16 条，避免超请求体和限流）
  const BATCH = 16;
  const withVectors: { chapter: string; index: number; text: string; vector: number[] }[] = [];
  for (let i = 0; i < chunks.length; i += BATCH) {
    const batch = chunks.slice(i, i + BATCH);
    const vectors = await embed(batch.map((c) => c.text));
    batch.forEach((c, j) => withVectors.push({ ...c, vector: vectors[j] }));
    console.log(`  已向量化 ${Math.min(i + BATCH, chunks.length)}/${chunks.length}`);
  }

  const novelId = createNovel(title);
  insertChunks(novelId, withVectors);
  console.log(`✅ 入库完成，novelId=${novelId}`);
  console.log('已有小说:', listNovels().map((n: any) => `${n.title}(${n.chunkCount}块)`).join(', '));
}

main().catch((err) => {
  console.error('❌ 入库失败:', err.message);
  process.exit(1);
});
