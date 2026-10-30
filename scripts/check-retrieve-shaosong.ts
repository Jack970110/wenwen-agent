import 'dotenv/config';
import { ragScope } from '../src/rag/context.js';
import { retrieve, retrieveMulti } from '../src/rag/retrieve.js';
import { getNovelByTitle } from '../src/rag/store.js';

const novel = getNovelByTitle('绍宋');
if (!novel) throw new Error('绍宋 not found');

await ragScope.run({ onlyPublic: false, tier: 'T4', fullText: null }, async () => {
  const q = '绍宋这本书讲了什么故事';
  console.log('=== 单路 retrieve ===');
  const r1 = await retrieve(q, 3, novel.id);
  r1.forEach((r: any) => console.log('-', (r.novelTitle || novel.title), r.chapter || r.label || '', '|', String(r.text || '').slice(0, 80).replace(/\n/g, ' ')));

  console.log('=== T4 retrieveMulti（查询分解） ===');
  const r2 = await retrieveMulti(q, 5, novel.id);
  r2.forEach((r: any) => console.log('-', (r.novelTitle || novel.title), r.chapter || r.label || '', '|', String(r.text || '').slice(0, 80).replace(/\n/g, ' ')));
});
