import { readFileSync } from 'node:fs';
import { chunkNovel } from '../src/rag/chunker.js';

const chunks = chunkNovel(readFileSync(process.argv[2] || 'data/雪夜来客.txt', 'utf-8'));
console.log('切块数:', chunks.length);
chunks.forEach((c) => console.log(`[${c.index}] 全局第${c.globalChapter}章 ${c.volumeLabel ?? ''} ${c.chapterLabel} | ${c.text.length}字 | ${c.text.slice(0, 30).replace(/\n/g, ' ')}...`));
