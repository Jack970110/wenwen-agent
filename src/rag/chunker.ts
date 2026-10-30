/**
 * 小说文本切块器 v2（RAG 效果的第一决定因素）。
 *
 * 策略：
 * 1. 双层标题识别：卷（第X卷/卷X）→ 章（第X章/楔子/序章/番外/后记/尾声/终章）
 * 2. 全局章节计数：按出现顺序递增，与原文标注的编号无关——
 *    解决"每卷从第一章重新编号"导致的统计歧义（如 433 个标题但原文只标到第三十五章）
 * 3. 按段落聚合，每块 ~400 字，块前缀带三层出处信息（卷/章/全局序号）——引用溯源的依据
 * 4. 超长段落硬切，孤立小块并入前块
 * 5. 段落模式自动降级：全文无任何章节标题（文档类文本）时，改按空行分界切"段"
 *    （出处前缀 [第N段]），并强制块间重叠（默认 60 字符）
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

/**
 * 自定义切块参数（不传则用默认值）：
 * - targetSize / minSize：目标块长与孤立小块合并阈值
 * - overlap：相邻块间重叠字符数（仅在**同一章内**生效——跨章重叠会污染出处前缀，章节边界处强制截断）
 * - separators：自定义边界正则，替换默认的卷/章识别；文档类文本可用
 *   `{ chapter: /\n\n/ }` 之类按分隔符切（无卷概念则省略 volume）
 */
export interface ChunkOptions {
  targetSize?: number;
  minSize?: number;
  overlap?: number;
  separators?: { volume?: RegExp; chapter?: RegExp };
}

export function chunkNovel(rawText: string, opts: ChunkOptions = {}): NovelChunk[] {
  const targetSize = opts.targetSize && opts.targetSize > 0 ? opts.targetSize : TARGET_SIZE;
  const minSize = opts.minSize && opts.minSize > 0 ? opts.minSize : MIN_SIZE;
  const VOLUME_RE_C = opts.separators?.volume ?? VOLUME_RE;
  const CHAPTER_RE_C = opts.separators?.chapter ?? CHAPTER_RE;

  const lines = rawText.replace(/\r\n/g, '\n').split('\n');

  // 段落模式自动降级：全文没有任何章节标题时（文档类文本），
  // 改按空行分界切"段"，并强制块间重叠——没有章节边界时，
  // 重叠是保住被切断句子上下文的唯一手段（小说模式默认不重叠，此处默认 60）
  const sectionMode = !lines.some((l) => CHAPTER_RE_C.test(l.trim()));
  const overlap = opts.overlap && opts.overlap > 0
    ? Math.floor(opts.overlap)
    : sectionMode ? 60 : 0;

  let globalChapter = 0;
  let volumeLabel: string | undefined;
  let chapterLabel = '序';
  // 段落模式：首个内容行即第 1 段，之后每个空行分界开新段
  let pendingBoundary = sectionMode;
  const chunks: NovelChunk[] = [];
  let index = 0;
  let buffer = '';

  const sourcePrefix = () => {
    if (sectionMode) return `[第${globalChapter}段]`;
    const vol = volumeLabel ? `${volumeLabel} · ` : '';
    return `[全书第${globalChapter}章] ${vol}${chapterLabel}`;
  };

  // 尾部携带：块间重叠的实现方式——flush 后把本块尾部字符预填进下一块 buffer。
  // carryTail=false 用于章节边界（新的语义单元，不携带上文）。
  const flush = (carryTail = true) => {
    const text = buffer.trim();
    const tail = overlap > 0 && carryTail && text.length > overlap ? text.slice(-overlap) : '';
    if (text.length < minSize && chunks.length > 0 && chunks[chunks.length - 1].globalChapter === globalChapter) {
      // 孤立小块并入前块（仅同章节内）
      const prev = chunks[chunks.length - 1];
      prev.text += '\n' + text;
      buffer = tail;
      return;
    }
    if (text) {
      chunks.push({ globalChapter, chapterLabel, volumeLabel, index: index++, text: `${sourcePrefix()}\n${text}` });
    }
    buffer = tail;
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (sectionMode) pendingBoundary = true; // 空行 = 段落分界标记
      continue;
    }

    if (!sectionMode && VOLUME_RE_C.test(trimmed)) {
      flush(false);
      volumeLabel = trimmed; // 卷标题不占章节计数，只作为后续章节的出处前缀
      continue;
    }

    if (!sectionMode && CHAPTER_RE_C.test(trimmed)) {
      flush(false);
      chapterLabel = trimmed;
      globalChapter++;
      continue;
    }

    if (sectionMode && pendingBoundary) {
      flush(false);
      globalChapter++;
      chapterLabel = `第${globalChapter}段`;
      pendingBoundary = false;
    }

    // 超长段落硬切（带重叠：步长 = targetSize - overlap）
    if (trimmed.length > targetSize) {
      flush(false);
      const step = overlap > 0 ? Math.max(1, targetSize - overlap) : targetSize;
      for (let i = 0; i < trimmed.length; i += step) {
        const piece = trimmed.slice(i, i + targetSize);
        chunks.push({ globalChapter, chapterLabel, volumeLabel, index: index++, text: `${sourcePrefix()}\n${piece}` });
        if (i + targetSize >= trimmed.length) break; // 最后一片不满，防止空 overlap 片
      }
      // 尾部携带供后续段落接续
      const last = chunks[chunks.length - 1];
      buffer = overlap > 0 ? last.text.slice(-overlap) : '';
      continue;
    }

    buffer += (buffer ? '\n' : '') + trimmed;
    if (buffer.length >= targetSize) flush();
  }
  flush(false);

  return chunks;
}
