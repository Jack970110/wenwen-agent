import { getNovelByTitle, getNovelFullText, getNovelMeta, getChapterTextRows } from './rag/store.js';
import { chunkNovel } from './rag/chunker.js';
import { chatLog } from './logger.js';

/**
 * 文本统计服务层：小说文本的确定性统计信号（novelAnalysis 剧本的取数层）。
 * 与 dataService 同一设计：纯业务逻辑、协议无关——剧本/MCP/FC 都可以复用。
 *
 * 信号分两级：
 * - 章级：字数、段落颗粒度、对话密度、人称占比（给模型研判「哪章值得细看」的地图）
 * - 全书级：节奏曲线聚合、结构健康度
 * 全部是启发式信号（引号≈对话、开合≈节奏），剧本的 prompt 必须告知模型
 * 「这是近似值，下结论前要结合原文核实」——统计负责不漏，模型负责判对错。
 *
 * 数据来源：T2+ 直接扫 chunks 表 level 0 原文块；T1 没有向量化但存了 full_text，
 * 现场重切块（chunkNovel 是纯函数，无副作用）。两者统一走「按章聚合 + 去前缀 + 去重叠」。
 */

/** 块文本的出处前缀（第一行，如 `[全书第3章] 第一卷 · 明道宫` 或 `[第N段]`）对统计是噪声 */
function stripSourcePrefix(text: string): string {
  const nl = text.indexOf('\n');
  if (nl > 0 && /^\[(全书第|第\d+段)/.test(text.slice(0, nl))) return text.slice(nl + 1);
  return text;
}

/** 相邻块同章重叠（chunker 的 overlap 设计）会让字数虚高：后块开头若与累积文本结尾重复则跳过 */
function dedupeOverlap(chunks: string[]): string {
  let out = '';
  for (const c of chunks) {
    const maxK = Math.min(c.length, out.length, 200);
    let k = maxK;
    for (; k >= 10; k--) if (out.endsWith(c.slice(0, k))) break;
    out += k >= 10 ? c.slice(k) : c;
  }
  return out;
}

/** 按章取正文：优先 chunks level 0；没有块（T1）用 full_text 现场重切 */
function loadChapterTexts(novelId: string): { no: number; label: string; text: string }[] {
  const rows = getChapterTextRows(novelId);

  if (rows.length) {
    // 同章多块聚合：块序即原文序，按 chapter 标签分组
    const byChapter = new Map<string, string[]>();
    for (const r of rows) {
      const list = byChapter.get(r.chapter) ?? [];
      list.push(stripSourcePrefix(r.text));
      byChapter.set(r.chapter, list);
    }
    return [...byChapter.entries()].map(([label, list], i) => ({ no: i + 1, label, text: dedupeOverlap(list) }));
  }

  const full = getNovelFullText(novelId);
  if (!full) return [];
  return chunkNovel(full).map((c) => ({ no: c.globalChapter, label: c.chapterLabel, text: stripSourcePrefix(c.text) }));
}

/** 对话字符提取：「」『』和中文弯引号；不含普通 "（英文语料才用，中文里多为误标） */
const DIALOGUE_RE = /[「][^」]*[」]|[『][^』]*[』]|[“][^”]*[”]/g;

function chapterSignal(no: number, label: string, text: string) {
  const body = text.replace(/\s+/g, '');
  const paragraphs = text.split(/\n+/).map((p) => p.replace(/\s+/g, '')).filter((p) => p.length > 0);
  const dialogues = text.match(DIALOGUE_RE) ?? [];
  const dialogueChars = dialogues.join('').length;

  return {
    no,
    label,
    chars: body.length,
    /** 段落数与段落长度：段落颗粒度（手机阅读体验的硬指标） */
    paragraphs: paragraphs.length,
    avgParaLen: paragraphs.length ? Math.round(body.length / paragraphs.length) : 0,
    maxParaLen: paragraphs.length ? Math.max(...paragraphs.map((p) => p.length)) : 0,
    /** 对话占比与对话块数：对话密度的两个面——占比看浓度，块数看节奏切换频率 */
    dialogueRatio: body.length ? Number((dialogueChars / body.length).toFixed(3)) : 0,
    dialogueBlocks: dialogues.length,
    /** 人称占比（POV 近似）：第一人称 vs 第三人称出现次数 */
    firstPerson: (body.match(/我/g) ?? []).length,
    thirdPerson: (body.match(/[他她它]/g) ?? []).length,
  };
}

export type ChapterSignal = ReturnType<typeof chapterSignal>;

export interface TextSignals {
  novelId: string;
  title: string;
  tier?: string;
  structureType?: 'chapter' | 'section';
  totalChapters: number;
  totalChars: number;
  avgChapterChars: number;
  /** 章长标准差/均值：>0.35 说明节奏（章长）波动过大 */
  chapterLenCV: number;
  dialogueRatio: number;
  /** 对话占比偏离全书均值 2 倍以上的章（节奏异常的候选） */
  dialogueOutliers: { no: number; label: string; ratio: number }[];
  /** 显著长于/短于均值的章（节奏曲线的极值点） */
  lengthExtremes: { longest: ChapterSignal | null; shortest: ChapterSignal | null };
  chapters: ChapterSignal[];
  /** 统计口径说明（进 prompt：这些是启发式，模型要核实再下结论） */
  caveats: string[];
}

/** 按全局章号取单章原文（模型研判的定向细读工具；超长截断防上下文爆炸） */
export function getChapterText(
  novelTitle: string,
  no: number,
  maxChars = 9000,
): { error: string } | { label: string; text: string; truncated: boolean } {
  const novel = getNovelByTitle(novelTitle);
  if (!novel) return { error: `知识库中没有《${novelTitle}》` };
  const chapters = loadChapterTexts(novel.id);
  const target = chapters[no - 1];
  if (!target) return { error: `《${novelTitle}》没有第 ${no} 章（共 ${chapters.length} 章）` };
  const truncated = target.text.length > maxChars;
  chatLog.info({ novel: novelTitle, no }, '章节原文已取出（文本分析）');
  return { label: target.label, text: truncated ? target.text.slice(0, maxChars) : target.text, truncated };
}

export function getTextSignals(novelTitle: string): TextSignals | { error: string } {
  const novel = getNovelByTitle(novelTitle);
  if (!novel) return { error: `知识库中没有《${novelTitle}》` };
  const meta = getNovelMeta(novel.id);

  const chapters = loadChapterTexts(novel.id).map((c) => chapterSignal(c.no, c.label, c.text));
  if (!chapters.length) return { error: `《${novelTitle}》没有可分析的文本（未入库或空文档）` };

  const totalChars = chapters.reduce((s, c) => s + c.chars, 0);
  const avg = Math.round(totalChars / chapters.length);
  const variance = chapters.reduce((s, c) => s + (c.chars - avg) ** 2, 0) / chapters.length;
  const cv = avg > 0 ? Number((Math.sqrt(variance) / avg).toFixed(3)) : 0;

  const totalDialogue = chapters.reduce((s, c) => s + c.dialogueRatio * c.chars, 0);
  const dialogueRatio = totalChars ? Number((totalDialogue / totalChars).toFixed(3)) : 0;

  const sorted = [...chapters].sort((a, b) => a.chars - b.chars);
  const outliers = chapters
    .filter((c) => c.chars > 100 && (c.dialogueRatio < dialogueRatio * 0.4 || c.dialogueRatio > Math.min(dialogueRatio * 1.8, 1)))
    .map((c) => ({ no: c.no, label: c.label, ratio: c.dialogueRatio }));

  const signals: TextSignals = {
    novelId: novel.id,
    title: novel.title,
    tier: meta?.tier,
    structureType: meta?.structureType,
    totalChapters: chapters.length,
    totalChars,
    avgChapterChars: avg,
    chapterLenCV: cv,
    dialogueRatio,
    dialogueOutliers: outliers.slice(0, 10),
    lengthExtremes: { longest: sorted[sorted.length - 1], shortest: sorted[0] },
    chapters,
    caveats: [
      '对话占比按引号字符估算，不含转述式对话，数值偏低是正常现象',
      '人称占比是 POV 的粗糙近似（我 vs 他/她/它），不能直接断定视角切换',
      '段落以换行为界，网页排版的空行差异会影响段落数',
    ],
  };
  chatLog.info({ novel: novel.title, chapters: chapters.length, totalChars }, '文本画像已生成');
  return signals;
}
