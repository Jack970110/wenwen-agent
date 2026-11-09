import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { generateText, stepCountIs, tool } from 'ai';
import { z } from 'zod';
import { getChapterText, getTextSignals, type TextSignals } from '../../textService.js';
import { getNovelByTitle } from '../../rag/store.js';
import { retrieve } from '../../rag/retrieve.js';
import { analyzeTrendData, resolveDataset } from '../../dataService.js';
import { ragScope } from '../../rag/context.js';
import type { JobContext } from '../runner.js';

/**
 * 剧本：小说文本分析（模型驱动版，与 dataAnalysis 的确定性管线形成对照）。
 * 骨架仍走 runner（受理/进度/取消/产物落库），但中间的「研判」环节是
 * agent loop——模型带着文本画像和工具，自主决定看哪些章、检索什么证据。
 * 统计信号负责「不漏」（全量扫描），模型负责「判对错」（编辑标准研判）。
 */

const zhipu = createOpenAICompatible({
  name: 'zhipu',
  baseURL: 'https://open.bigmodel.cn/api/paas/v4',
  apiKey: process.env.ZHIPU_API_KEY,
});

/** 画像的 prompt 视图：章曲线压缩成 [序号, 字数, 对话占比]，不把 433 章全量 JSON 塞上下文 */
function compactSignals(s: TextSignals) {
  return {
    title: s.title, tier: s.tier, structureType: s.structureType,
    totalChapters: s.totalChapters, totalChars: s.totalChars,
    avgChapterChars: s.avgChapterChars, chapterLenCV: s.chapterLenCV,
    dialogueRatio: s.dialogueRatio,
    dialogueOutliers: s.dialogueOutliers,
    lengthExtremes: s.lengthExtremes && {
      longest: s.lengthExtremes.longest && { no: s.lengthExtremes.longest.no, label: s.lengthExtremes.longest.label, chars: s.lengthExtremes.longest.chars, dialogueRatio: s.lengthExtremes.longest.dialogueRatio },
      shortest: s.lengthExtremes.shortest && { no: s.lengthExtremes.shortest.no, label: s.lengthExtremes.shortest.label, chars: s.lengthExtremes.shortest.chars, dialogueRatio: s.lengthExtremes.shortest.dialogueRatio },
    },
    chapterCurve: s.chapters.map((c) => [c.no, c.chars, c.dialogueRatio]),
    caveats: s.caveats,
  };
}

export async function runNovelAnalysis(ctx: JobContext): Promise<string> {
  const novelTitle = (ctx.params.novelTitle as string) || '';
  // 游客边界：只许分析公开库的书（画像/读原文走直查，绕过检索作用域，必须在这里拦）
  const target = getNovelByTitle(novelTitle);
  if (target && ctx.publicOnly && target.owner !== 'public') throw new Error('没有权限分析该小说');
  // 交叉归因的数据集：UI 显式选择优先，没选则保守自动匹配（唯一候选才采用）
  const dataset = resolveDataset(novelTitle, ctx.owner, ctx.params.datasetName as string | undefined);
  const datasetName = dataset?.name;

  return ragScope.run({ onlyPublic: ctx.publicOnly, tier: 'T2' }, async () => {
    // ---- 步骤 1：文本画像（确定性统计）----
    await ctx.beginStep('生成文本画像');
    if (ctx.signal.aborted) throw new Error('cancelled');
    const signals = getTextSignals(novelTitle);
    if ('error' in signals) throw new Error(signals.error);
    await ctx.finishStep(
      `${signals.totalChapters} 章 / ${signals.totalChars} 字（${signals.tier}），全书对话占比 ${(signals.dialogueRatio * 100).toFixed(1)}%，` +
      `章长变异系数 ${signals.chapterLenCV}，对话异常章 ${signals.dialogueOutliers.length} 个`,
    );

    // ---- 步骤 2：模型研判（agent loop，模型驱动）----
    await ctx.beginStep('编辑标准研判');
    if (ctx.signal.aborted) throw new Error('cancelled');
    const novel = getNovelByTitle(novelTitle);

    const findings = await generateText({
      model: zhipu(process.env.MODEL_FAST || 'glm-4-flash'),
      abortSignal: ctx.signal,
      maxRetries: 2,
      stopWhen: stepCountIs(12),
      system:
        '你是资深网文编辑。基于文本画像和工具，按编辑标准研判这部作品，输出研判笔记（markdown，不是最终报告）：\n' +
        '## 开头钩子（细读第 1~3 章：悬念钩、主角动机建立）\n' +
        '## 节奏与结构（章长曲线、对话占比异常处抽样核实）\n' +
        '## 对话与段落颗粒度（是否适配手机阅读）\n' +
        '## 人物与视角（出场分布、POV 稳定度）\n' +
        '## 总评（3 条以内核心问题）\n' +
        '要求：统计信号是启发式近似（对话按引号估算、人称是粗糙统计），发现异常先用 readChapter 或 searchScene 核实原文再下结论；' +
        '每个结论标注章节出处；核实不了的如实说明。写作工具前先想清楚查什么，控制在 10 次工具调用以内。',
      prompt:
        `# 文本画像（全书统计）\n${JSON.stringify(compactSignals(signals))}\n\n` +
        `请开始研判。工具里的 novelTitle 固定传「${novelTitle}」。`,
      tools: {
        getChapterStats: tool({
          description: '查询指定章节的统计信号（字数/段落/对话占比/人称）',
          inputSchema: z.object({
            from: z.number().int().describe('起始章号'),
            to: z.number().int().optional().describe('结束章号（含），不传只查一章'),
          }),
          execute: async ({ from, to }) => {
            const list = signals.chapters.slice(from - 1, (to ?? from));
            return list.length ? list : { error: `章号超出范围（1~${signals.totalChapters}）` };
          },
        }),
        readChapter: tool({
          description: '读取某章原文（超长自动截断）。用于核实统计异常或细读关键章节',
          inputSchema: z.object({
            no: z.number().int().describe('全局章号'),
          }),
          execute: async ({ no }) => getChapterText(novelTitle, no),
        }),
        searchScene: tool({
          description: '在本书内做语义检索，返回相关原文片段（含章节出处）。查人物、情节、特定场景用这个',
          inputSchema: z.object({
            query: z.string().describe('要检索的内容描述'),
          }),
          execute: async ({ query }) => {
            if (!novel) return { error: '本书未入库' };
            const results = await retrieve(query, 3, novel.id);
            return results.map((r) => `【${r.novelTitle ?? novelTitle} · ${r.chapter}】${r.text.slice(0, 200)}`);
          },
        }),
      },
    });
    await ctx.finishStep(`研判笔记 ${findings.text.length} 字（${(findings.steps as unknown[] | undefined)?.length ?? 0} 轮工具循环）`);

    // ---- 步骤 3：合成报告（可带阅读数据交叉归因）----
    await ctx.beginStep('生成分析报告');
    if (ctx.signal.aborted) throw new Error('cancelled');
    let dataBrief = '';
    let linkedNote = '';
    if (datasetName) {
      linkedNote = dataset.how === 'explicit' ? `已关联数据集「${datasetName}」（用户指定）` : `已自动匹配数据集「${datasetName}」`;
      const chapters = signals.chapters;
      const trend = analyzeTrendData(chapters[0].no, chapters[chapters.length - 1].no, datasetName) as any;
      if (!trend.error) {
        dataBrief =
          `\n\n# 阅读数据交叉信号（数据集「${datasetName}」）\n` +
          `完读率最低：${trend.lowestFinishRate?.chapter}（${trend.lowestFinishRate?.rate}）；` +
          `追更流失章节：${(trend.chaptersLosingFollowers ?? []).map((c: any) => `${c.chapter}(${c.netFollow7d})`).join('、') || '无'}` +
          `；阅读人数变化 ${trend.readerChangePercent}%。请把数据异常点与你的文本研判相互印证（章号可能不完全对齐，按章节标注核对）。`;
      }
    } else if (ctx.params.datasetName) {
      linkedNote = `指定的数据集「${ctx.params.datasetName}」不存在，本次为纯文本分析`;
    }
    let markdown: string;
    try {
      const report = await generateText({
        model: zhipu(process.env.MODEL_FAST || 'glm-4-flash'),
        abortSignal: ctx.signal,
        maxRetries: 2,
        system:
          '你是网文数据分析师。基于编辑研判笔记' + (dataBrief ? '和阅读数据交叉信号' : '') +
          '，输出一份简明的 markdown 作品分析报告：\n## 作品概览\n## 亮点\n## 问题诊断（逐条：现象 + 章节证据）\n## 修改建议（3 条以内）\n' +
          '要求：结论先行、标注章节出处、笔记里没有的内容不编造。',
        prompt: `# 编辑研判笔记\n${findings.text}\n${dataBrief ? `# 数据交叉\n${dataBrief}` : ''}`,
      });
      markdown = report.text;
    } catch (err) {
      // 降级：模型挂了/没配 key，报告退回研判笔记 + 画像结论——任务仍然成功
      markdown = [
        '# 小说文本分析报告（数据摘要版）', '',
        `> 注：报告合成步骤失败（${err instanceof Error ? err.message.slice(0, 80) : '未知错误'}），以下为研判笔记与画像结论。`, '',
        `## 文本画像`,
        `- ${signals.totalChapters} 章 / ${signals.totalChars} 字，章均 ${signals.avgChapterChars} 字（变异系数 ${signals.chapterLenCV}）`,
        `- 全书对话占比 ${(signals.dialogueRatio * 100).toFixed(1)}%，异常章：${signals.dialogueOutliers.map((o) => `第${o.no}章(${(o.ratio * 100).toFixed(0)}%)`).join('、') || '无'}`,
        '', '## 编辑研判笔记', findings.text,
      ].join('\n');
    }
    await ctx.finishStep(`报告 ${markdown.length} 字${linkedNote ? `（${linkedNote}）` : '（未关联阅读数据，纯文本分析）'}`);
    return markdown;
  });
}
