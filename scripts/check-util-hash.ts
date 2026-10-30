import { mapPool, envPositive } from '../src/rag/util.js';
import { contentHash, findNovelByContentHash } from '../src/rag/store.js';

(async () => {
  // 并发池：保序 + 全覆盖（任务完成时间乱序也不影响结果顺序）
  const r = await mapPool([10, 20, 30, 40, 50], 2, async (n) => {
    await new Promise((res) => setTimeout(res, 60 - n / 10));
    return n * 2;
  });
  console.log('mapPool 保序:', JSON.stringify(r) === JSON.stringify([20, 40, 60, 80, 100]));
  console.log('envPositive 默认回退:', envPositive('NOPE_X_TEST', 3) === 3);

  // 指纹：同内容同哈希，查重命中自身
  const h1 = contentHash('hello world');
  const h2 = contentHash('hello ' + 'world');
  console.log('同内容同指纹:', h1 === h2, '| 不同内容不同指纹:', h1 !== contentHash('bye'));
  console.log('库内查重（应返回 undefined 或已有书）:', findNovelByContentHash(h1)?.title ?? 'undefined（无同内容书）');
})();
