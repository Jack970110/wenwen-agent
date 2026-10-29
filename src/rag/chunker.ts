/**
 * 小说文本切块器 v2（RAG 效果的第一决定因素）。
 *
 * 策略：
 * 1. 双层标题识别：卷（第X卷/卷X）→ 章（第X章/楔子/序章/番外/后记/尾声/终章）
 * 2. 全局章节计数：按出现顺序递增，与原文标注的编号无关——
 *    解决"每卷从第一章重新编号"导致的统计歧义（如 433 个标题但原文只标到第三十五章）
 * 3. 按段落聚合，每块 ~400 字，块前缀带三层出处信息（卷/章/全局序号）——引用溯源的依据
 * 4. 超长段落硬切，孤立小块并入前块
 */

export interface NovelChunk {
  globalChapter: number;  // 全局章节序号（1 起，按标题出现顺序）
  chapterLabel: string;   // 原文章节标题（如"第一章 明道宫"）
  volumeLabel?: string;   // 所属卷标题（原文没有卷结构则为空）
  index: number;          // 块序号
  text: string;           // 块内容（前缀含出处信息）
}

const TARGET_SIZE = 400;
const MIN_SIZE = 80;

const CHAPTER_RE = /^(第[一二三四五六七八九十百千零两0-9]+章|楔子|序章|尾声|终章|番外(?:[ \u3000])*[一二三四五六七八九十0-9]*)/;
const VOLUME_RE = /^(第[一二三四五六七八九十百千零两0-9]+卷|卷[一二三四五六七八九十]+)/;

export function chunkNovel(rawText: string): NovelChunk[] {
  const lines = rawText.replace(/\r\n/g, '\n').split('\n');

  let globalChapter = 0;
  let volumeLabel: string | undefined;
  let chapterLabel = '序';
  const chunks: NovelChunk[] = [];
  let index = 0;
  let buffer = '';

  const sourcePrefix = () => {
    const vol = volumeLabel ? `${volumeLabel} · ` : '';
    return `[全书第${globalChapter}章] ${vol}${chapterLabel}`;
  };

  const flush = () => {
    const text = buffer.trim();
    if (text.length < MIN_SIZE && chunks.length > 0 && chunks[chunks.length - 1].globalChapter === globalChapter) {
      // 孤立小块并入前块（仅同章节内）
      const prev = chunks[chunks.length - 1];
      prev.text += '\n' + text;
      buffer = '';
      return;
    }
    if (text) {
      chunks.push({ globalChapter, chapterLabel, volumeLabel, index: index++, text: `${sourcePrefix()}\n${text}` });
      buffer = '';
    }
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (VOLUME_RE.test(trimmed)) {
      flush();
      volumeLabel = trimmed; // 卷标题不占章节计数，只作为后续章节的出处前缀
      continue;
    }

    if (CHAPTER_RE.test(trimmed)) {
      flush();
      chapterLabel = trimmed;
      globalChapter++;
      continue;
    }

    // 超长段落硬切
    if (trimmed.length > TARGET_SIZE) {
      flush();
      for (let i = 0; i < trimmed.length; i += TARGET_SIZE) {
        chunks.push({ globalChapter, chapterLabel, volumeLabel, index: index++, text: `${sourcePrefix()}\n${trimmed.slice(i, i + TARGET_SIZE)}` });
      }
      continue;
    }

    buffer += (buffer ? '\n' : '') + trimmed;
    if (buffer.length >= TARGET_SIZE) flush();
  }
  flush();

  return chunks;
}
