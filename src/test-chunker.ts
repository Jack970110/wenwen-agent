import { readFileSync } from 'node:fs';
import { chunkNovel } from './rag/chunker.js';

const chunks = chunkNovel(readFileSync(process.argv[2] || 'data/雪夜来客.txt', 'utf-8'));
console.log('切块数:', chunks.length);
chunks.forEach((c) => console.log(`[${c.index}] ${c.chapter} | ${c.text.length}字 | ${c.text.slice(0, 30).replace(/\n/g, ' ')}...`));
