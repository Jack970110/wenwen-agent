import { chunkNovel } from '../src/rag/chunker.js';

const para = (n: number) => Array.from({ length: n }, (_, i) => '段落内容'.repeat(10) + ' ' + i).join('\n');
const text = '第一章 开端\n' + para(30) + '\n第二章 发展\n' + para(30);

const def = chunkNovel(text);
const ov = chunkNovel(text, { overlap: 60 });
console.log('默认块数:', def.length, '| overlap块数:', ov.length);

// 章节边界不携带重叠：第二章首块应直接以出处前缀开头
const firstOfCh2 = ov.find((c) => c.chapterLabel === '第二章 发展');
console.log('跨章不重叠(首块以前缀开头):', firstOfCh2?.text.startsWith('[全书第2章] 第二章 发展'));

// 同章内块间重叠：第2块开头应包含第1块尾部内容
const o1 = ov[0].text;
const o2 = ov[1]?.text ?? '';
const tail = o1.slice(-30);
console.log('同章块间重叠生效:', o2.includes(tail));

// 自定义分隔符：无章节结构的文本按空行分段
const doc = '条款一内容较多一些。'.repeat(30) + '\n\n条款二内容也很多。'.repeat(30);
const custom = chunkNovel(doc, { separators: { chapter: /^$/ }, targetSize: 200 });
console.log('自定义分隔符块数:', custom.length);

// 默认参数下行为与旧版一致（无重叠 → 相邻块无重复合并、孤立块并入前块）
const sparse = '第一章 A\n短句。\n' + para(5) + '\n第二章 B\n' + para(5);
const merged = chunkNovel(sparse);
console.log('默认路径块数(含孤立块合并):', merged.length, '| 第1块含短句:', merged[0].text.includes('短句。'));

// ===== 段落模式自动降级：无章节标题的文档类文本 =====
const plainDoc = Array.from({ length: 12 }, (_, i) => '这是文档第' + (i + 1) + '段的内容。'.repeat(8)).join('\n\n');
const docChunks = chunkNovel(plainDoc);
console.log('--- 段落模式 ---');
console.log('块数:', docChunks.length, '| 段数(全局):', new Set(docChunks.map((c) => c.globalChapter)).size);
console.log('出处前缀:', docChunks.map((c) => c.text.split('\n')[0]).filter((v, i, a) => a.indexOf(v) === i).slice(0, 4));
// 段落模式强制重叠：相邻块同段内应有尾部重合
const d1 = docChunks[0].text, d2 = docChunks[1]?.text ?? '';
console.log('段内块间重叠生效(同段时):', d2.split('\n')[0].startsWith('[第') ? '下块是新段(不重叠,正确)' : d2.includes(d1.slice(-30)));
// 章节文本不受降级影响
const novelChunks = chunkNovel('第一章 甲\n' + para(5) + '\n\n第二章 乙\n' + para(5));
console.log('章节文本仍走章节模式:', novelChunks[0].text.startsWith('[全书第1章]'), '| 段落数=2章:', new Set(novelChunks.map((c) => c.globalChapter)).size === 2);
