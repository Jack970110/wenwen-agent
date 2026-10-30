import type { NovelChunk } from './chunker.js';
import { embed } from './embed.js';
import { getClient, summarizeChapters } from './summarize.js';
import { generateText } from 'ai';
import { insertChunks, setNovelBookSummary } from './store.js';
import { envPositive, mapPool } from './util.js';
import { summaryLog } from '../logger.js';

/**
 * 摘要层构建（T3/T4）：入库管道两条路径（CLI / Web 异步）共用。
 * - 章摘要（level 1）：快模型批量生成 ~300 字概括（一次调用多章），向量化入库
 * - 段落摘要（level 2，仅 T4）：每 30 章聚合再概括，供全书级问题路由
 * 与原文块（level 0）同池检索，rerank 统一定序。
 *
 * 提速设计：SUMMARY_BATCH 章合并为一次 LLM 调用（默认 4），
 * SUMMARY_CONCURRENCY 个批调用并发跑（默认 3）——T4 几百章的书从
 * 串行几十分钟压到几分钟。env 可覆盖（限流严就调小）。
 */

const SUMMARY_BATCH = envPositive('SUMMARY_BATCH', 4);
const SUMMARY_CONCURRENCY = envPositive('SUMMARY_CONCURRENCY', 3);

interface ChapterGroup {
  no: number;
  label: string;
  volume?: string;
  text: string;
}

const SEGMENT_SIZE = 30; // T4 段落摘要的章聚合粒度

function groupByChapter(chunks: NovelChunk[]): ChapterGroup[] {
  const map = new Map<number, ChapterGroup>();
  for (const c of chunks) {
    // 块文本首行是出处前缀，摘要输入用正文部分
    const body = c.text.split('\n').slice(1).join('\n');
    const g = map.get(c.globalChapter);
    if (g) g.text += '\n' + body;
    else map.set(c.globalChapter, { no: c.globalChapter, label: c.chapterLabel, volume: c.volumeLabel, text: body });
  }
  return [...map.values()].sort((a, b) => a.no - b.no);
}

/** 构建摘要层并入库，返回生成的摘要节点数 */
export async function buildSummaryLayer(
  novelId: string,
  chunks: NovelChunk[],
  tier: 'T3' | 'T4',
  onProgress?: (done: number, total: number) => void,
): Promise<number> {
  const chapterGroups = groupByChapter(chunks);
  const segmentTotal = tier === 'T4' ? Math.ceil(chapterGroups.length / SEGMENT_SIZE) : 0;
  const total = chapterGroups.length + segmentTotal;
  let done = 0;
  const t0 = Date.now();
  let skipped = 0;

  // 章摘要（level 1）：SUMMARY_BATCH 章/次调用 + SUMMARY_CONCURRENCY 并发
  const chapterSummaryChunks: (NovelChunk & { vector: number[] })[] = [];
  const batches: ChapterGroup[][] = [];
  for (let i = 0; i < chapterGroups.length; i += SUMMARY_BATCH) {
    batches.push(chapterGroups.slice(i, i + SUMMARY_BATCH));
  }
  await mapPool(batches, SUMMARY_CONCURRENCY, async (batch) => {
    try {
      const summaries = await summarizeChapters(batch.map((g) => ({ label: g.label, text: g.text })));
      // 摘要向量化也按批走（一次 embed 调用带 4 条文本）
      const texts = summaries.map((s, i) => `【章摘要】${batch[i].label}\n${s}`);
      const vectors = await embed(texts);
      batch.forEach((g, i) => {
        chapterSummaryChunks.push({
          globalChapter: g.no, chapterLabel: g.label, volumeLabel: g.volume,
          index: g.no, text: texts[i], vector: vectors[i],
        });
      });
    } catch (err) {
      // 批量失败（内容安全过滤 1301 / 限流重试耗尽）：降级为逐章重试，
      // 单章再失败只跳过该章——一章敏感不该让几百章的摘要全功尽弃
      summaryLog.warn({ err: err instanceof Error ? err.message.slice(0, 120) : String(err), chapters: batch.map((g) => g.label) }, '批量摘要失败，降级逐章');
      for (const g of batch) {
        try {
          const [s] = await summarizeChapters([{ label: g.label, text: g.text }]);
          const text = `【章摘要】${g.label}\n${s}`;
          const [vector] = await embed([text]);
          chapterSummaryChunks.push({
            globalChapter: g.no, chapterLabel: g.label, volumeLabel: g.volume,
            index: g.no, text, vector,
          });
        } catch (e2) {
          skipped++;
          summaryLog.warn({ chapter: g.label, err: e2 instanceof Error ? e2.message.slice(0, 80) : String(e2) }, '章节摘要跳过');
        }
      }
    }
    done += batch.length;
    onProgress?.(done, total);
  });
  chapterSummaryChunks.sort((a, b) => a.globalChapter - b.globalChapter);
  insertChunks(novelId, chapterSummaryChunks, 1);
  const tChapter = Date.now();
  summaryLog.info({ ms: Date.now() - t0, done: chapterSummaryChunks.length, totalChapters: chapterGroups.length, skipped }, '章摘要完成');

  // 段落摘要（level 2，仅 T4）：每 30 章的章摘要聚合再概括
  // 同样走并发池——串行 15 次是收尾阶段拖慢的主因（单次输入 30 份章摘要，是最耗时的调用类型）
  let segmentCount = 0;
  let segmentTexts: string[] = [];
  if (tier === 'T4') {
    const segmentChunks: (NovelChunk & { vector: number[] })[] = [];
    const segmentGroups: (typeof chapterSummaryChunks)[] = [];
    for (let start = 0; start < chapterSummaryChunks.length; start += SEGMENT_SIZE) {
      segmentGroups.push(chapterSummaryChunks.slice(start, start + SEGMENT_SIZE));
    }
    await mapPool(segmentGroups, SUMMARY_CONCURRENCY, async (group) => {
      const label = `第${group[0].globalChapter}-${group[group.length - 1].globalChapter}章合辑`;
      const [summary] = await summarizeChapters([{ label, text: group.map((s) => s.text).join('\n') }]);
      const text = `【段落摘要】${label}\n${summary}`;
      const [vector] = await embed([text]);
      segmentChunks.push({
        globalChapter: group[0].globalChapter, chapterLabel: label,
        index: group[0].globalChapter, text, vector,
      });
      onProgress?.(++done, total);
    });
    segmentChunks.sort((a, b) => a.globalChapter - b.globalChapter);
    insertChunks(novelId, segmentChunks, 2);
    segmentCount = segmentChunks.length;
    segmentTexts = segmentChunks.map((c) => c.text);
  }
  const tSegment = Date.now();
  if (tier === 'T4') summaryLog.info({ ms: Date.now() - tChapter, segments: segmentCount }, '段落摘要完成');

  // 顶层全书梗概（不向量化，聚焦时注入提示词）
  // T4 用段落摘要（15 条覆盖全书）；T3 用章摘要。
  // 注意段落摘要在独立的 segmentChunks 里（曾误从 chapterSummaryChunks 里筛前缀，
  // 筛出空数组 → 智谱报"未正常接收到prompt参数"）
  const summarySource = (segmentTexts.length > 0 ? segmentTexts : chapterSummaryChunks.map((c) => c.text));
  if (summarySource.length === 0) {
    throw new Error('无摘要节点可用于生成全书梗概（章摘要可能全部被跳过）');
  }
  await generateBookSummary(novelId, summarySource);
  summaryLog.info({ ms: Date.now() - tSegment, inputs: summarySource.length, summaryMs: Date.now() - t0 }, '全书梗概完成');

  return chapterSummaryChunks.length + segmentCount;
}

/**
 * 全书梗概：T3/T4 摘要层的顶层产物，存 novels.book_summary（不向量化）。
 * 为什么必须有它：章/段摘要都是"局部视角"，"这本书讲了什么故事"这种全书级
 * 问题在向量检索里没有天然命中物——顶层梗概在聚焦时注入提示词，由模型直接引用。
 * 输入用段落摘要（T4，已有分层概括）或章摘要（T3），超长截断。
 */
export async function generateBookSummary(
  novelId: string,
  chapterSummaryTexts: string[],
  onProgress?: (stage: string) => void,
): Promise<string> {
  // 输入超长时先分层预压缩：分组各出一段预摘要，再合并成全书梗概
  // （直接截断会只看到开头几章——绍宋首跑就踩过这个坑，输出退化成第一章梗概）
  const totalLen = chapterSummaryTexts.reduce((s, t) => s + t.length, 0);
  let input: string;
  if (totalLen <= 12000) {
    input = chapterSummaryTexts.join('\n');
  } else {
    const groups: string[] = [];
    let cur: string[] = [];
    let len = 0;
    for (const t of chapterSummaryTexts) {
      if (len + t.length > 6000 && cur.length) {
        groups.push(cur.join('\n'));
        cur = [];
        len = 0;
      }
      cur.push(t);
      len += t.length;
    }
    if (cur.length) groups.push(cur.join('\n'));
    const digests = await mapPool(groups, 3, (g, i) => {
      onProgress?.(`分组预摘要 ${i + 1}/${groups.length}`);
      return summarizeChapters([{ label: `第${i + 1}部分`, text: g.slice(0, 12000) }], 12000).then((r) => r[0]);
    });
    input = digests.join('\n');
  }

  // 终稿合成：不能用 summarizeChapters（它是"逐项概括"提示词，会把分组摘要碎片罗列），
  // 全书梗概需要的是叙事融合——按故事线把各部分揉成一段连贯的梗概
  const result = await generateText({
    model: getClient()(process.env.MODEL_FAST || 'glm-4-flash'),
    system: '你是网文编辑。输入是一部小说各部分的要点摘录，请把它们融合成一段 400-600 字的**全书故事梗概**：按叙事顺序讲清故事主线（起因、发展、高潮、结局）、主角是谁、核心冲突是什么。人物要求：输入中同一人的不同称谓（如"赵官家""官家""赵玖""赵构"）必须先识别并统一为同一角色，禁止拆成多个人；第一句就点明主角姓名与身份（如"主角赵玖，穿越为宋高宗赵构，书中称官家"）。要融合归纳成连贯故事，禁止逐条罗列，禁止占位词。',
    prompt: input.slice(0, 12000),
    maxRetries: 3,
  });
  const summary = result.text.trim();
  setNovelBookSummary(novelId, summary);
  return summary;
}
