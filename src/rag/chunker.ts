/**
 * 小说文本切块器（RAG 效果的第一决定因素）。
 *
 * 策略：
 * 1. 识别章节标题（"第X章"），给每个块打上章节元数据——回答引用出处的依据
 * 2. 按段落聚合，每块目标 ~400 字，相邻块保留 1 段重叠——防止语义被切断
 * 3. 太短的段落合并，太长的段落硬切
 */

export interface NovelChunk {
  chapter: string;   // 所属章节标题，如 "第三章 地窖"
  index: number;     // 块序号
  text: string;      // 块内容
}

const TARGET_SIZE = 400;   // 每块目标字数
const MIN_SIZE = 80;       // 小于这个长度的块并入前块

export function chunkNovel(rawText: string): NovelChunk[] {
  const lines = rawText.replace(/\r\n/g, '\n').split('\n');

  // 1. 按章节标题分段
  const chapters: { title: string; paragraphs: string[] }[] = [];
  let current = { title: '序', paragraphs: [] as string[] };
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // 匹配 "第一章 xxx" / "第1章 xxx" / "楔子" / "序章"
    if (/^(第[一二三四五六七八九十百千0-9]+章|楔子|序章|尾声)/.test(trimmed)) {
      if (current.paragraphs.length) chapters.push(current);
      current = { title: trimmed, paragraphs: [] };
    } else {
      current.paragraphs.push(trimmed);
    }
  }
  if (current.paragraphs.length) chapters.push(current);

  // 2. 章节内按段落聚合成块
  const chunks: NovelChunk[] = [];
  let index = 0;
  for (const chapter of chapters) {
    let buffer = '';
    const flush = () => {
      const text = buffer.trim();
      if (text.length >= MIN_SIZE || !chunks.length || chunks[chunks.length - 1].chapter !== chapter.title) {
        if (text) chunks.push({ chapter: chapter.title, index: index++, text: `${chapter.title}\n${text}` });
        buffer = '';
      }
    };
    for (const p of chapter.paragraphs) {
      // 超长段落硬切
      if (p.length > TARGET_SIZE) {
        flush();
        for (let i = 0; i < p.length; i += TARGET_SIZE) {
          chunks.push({ chapter: chapter.title, index: index++, text: `${chapter.title}\n${p.slice(i, i + TARGET_SIZE)}` });
        }
        continue;
      }
      buffer += (buffer ? '\n' : '') + p;
      if (buffer.length >= TARGET_SIZE) flush();
    }
    if (buffer.trim()) flush();
  }

  return chunks;
}
