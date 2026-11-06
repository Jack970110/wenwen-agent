import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { generateText } from 'ai';
import { analyzeTrendData, queryChaptersData } from '../../dataService.js';
import { getNovelByTitle } from '../../rag/store.js';
import { retrieve } from '../../rag/retrieve.js';
import { ragScope } from '../../rag/context.js';
import type { JobContext } from '../runner.js';

/**
 * 剧本：阅读数据分析报告（平台层第一个剧本，验证 runner 用）。
 * 结构化管线：流程代码即流程（取数→找异常→读原文→合成报告），
 * 模型只负责最后的内容合成——确定性步骤不交给模型，可控可测。
 * 数据源是 datasets/chapter_stats 表（内置演示数据 seed 自 mockData；用户上传的 CSV 走同一张表），
 * 取数统一走 dataService——换数据来源时本文件不动。
 */

const zhipu = createOpenAICompatible({
  name: 'zhipu',
  baseURL: 'https://open.bigmodel.cn/api/paas/v4',
  apiKey: process.env.ZHIPU_API_KEY,
});

/** 单个章节的归因笔记：限定在目标书的范围内检索原文；书未入库时明确说明 */
async function attributeChapter(chapterTitle: string, novelTitle: string, signal: AbortSignal): Promise<string> {
  const novel = getNovelByTitle(novelTitle);
  if (!novel) return `（《${novelTitle}》未入库，跳过原文归因——报告仅基于数据结论）`;
  const query = `${chapterTitle} 情节 内容`;
  const results = await retrieve(query, 2, novel.id);
  if (!results.length) return '（未检索到该章节相关原文，无法归因）';
  return results
    .map((r) => `【${r.novelTitle ?? novelTitle} · ${r.chapter}】${r.text.slice(0, 200)}`)
    .join('\n');
}

export async function runDataAnalysis(ctx: JobContext): Promise<string> {
  const novelTitle = (ctx.params.novelTitle as string) || '雪夜来客';

    // 游客边界：剧本里直接调用检索时也走作用域（只扫公开库）
    return ragScope.run({ onlyPublic: false, tier: 'T2' }, async () => {
    // ---- 步骤 1：获取章节阅读数据 ----
    await ctx.beginStep('获取章节阅读数据');
    if (ctx.signal.aborted) throw new Error('cancelled');
    const chapters = queryChaptersData(1, 99999, novelTitle) as any[];
    if (!chapters.length) throw new Error('没有可分析的章节数据');
    const span = `《${novelTitle}》第 ${chapters[0].chapterId}~${chapters[chapters.length - 1].chapterId} 章（共 ${chapters.length} 章）`;
    await ctx.finishStep(
      `${span}，阅读人数 ${chapters[0].readers7d} → ${chapters[chapters.length - 1].readers7d}，数据字段：阅读人数/完读率/净增追更`,
    );

    // ---- 步骤 2：趋势与异常检测 ----
    await ctx.beginStep('趋势与异常检测');
    if (ctx.signal.aborted) throw new Error('cancelled');
    const trend = analyzeTrendData(chapters[0].chapterId, chapters[chapters.length - 1].chapterId, novelTitle) as any;
    if (trend.error) throw new Error(trend.error);
    const problemChapters: { title: string; reason: string }[] = [
      { title: trend.lowestFinishRate.chapter, reason: `完读率最低（${trend.lowestFinishRate.rate}）` },
      ...trend.chaptersLosingFollowers.map((c: any) => ({ title: c.chapter, reason: `追更净增 ${c.netFollow7d}` })),
    ].filter((c, i, arr) => arr.findIndex((x) => x.title === c.title) === i).slice(0, 3);
    const extraNote = (trend.extraFindings as string[] | undefined)?.length
      ? '；' + (trend.extraFindings as string[]).join('；')
      : '';
    await ctx.finishStep(
      `阅读人数变化 ${trend.readerChangePercent}%；完读率最低：${trend.lowestFinishRate.chapter}（${trend.lowestFinishRate.rate}）；流失章节：${problemChapters.map((c) => c.title).join('、')}${extraNote}`,
    );

    // ---- 步骤 3：问题章节原文归因（subagent 思路的简化版：逐章检索原文）----
    await ctx.beginStep('问题章节原文归因');
    if (ctx.signal.aborted) throw new Error('cancelled');
    const notes: string[] = [];
    for (const c of problemChapters) {
      const note = await attributeChapter(c.title, novelTitle, ctx.signal);
      notes.push(`◆ ${c.title}（${c.reason}）\n${note}`);
      await ctx.finishStep(`已处理 ${notes.length}/${problemChapters.length} 章`);
    }
    await ctx.finishStep(`${problemChapters.length} 个问题章节均已检索原文并生成归因笔记`);

    // ---- 步骤 4：生成分析报告（LLM 合成；模型不可用时降级为结构化摘要）----
    await ctx.beginStep('生成分析报告');
    if (ctx.signal.aborted) throw new Error('cancelled');
    const brief = JSON.stringify(trend, null, 2);
    let markdown: string;
    try {
      const llm = await generateText({
        model: zhipu(process.env.MODEL_FAST || 'glm-4-flash'),
        abortSignal: ctx.signal,
        maxRetries: 2,
        system:
          '你是网文数据分析师。基于阅读数据概览（可能含评论/差评率/收入/字数等维度）和问题章节的原文笔记，输出一份简明的 markdown 分析报告：' +
          '## 数据表现（趋势概述，有额外维度的发现要提及，如章节长度与完读率的关系）\n## 问题诊断（逐个问题章节：数据异常 + 原文情节归因）\n## 修改建议（3 条以内，每条一句话）。' +
          '要求：结论先行、标注章节出处、笔记里没有的内容不编造。',
        prompt: `# 数据概览\n${brief}\n\n# 问题章节原文笔记\n${notes.join('\n\n')}`,
      });
      markdown = llm.text;
    } catch (err) {
      // 降级：模型挂了/没配 key，报告退回纯数据结论——任务仍然成功，可用性优先
      markdown = [
        '# 阅读数据分析报告（数据摘要版）', '',
        `> 注：模型合成步骤失败（${err instanceof Error ? err.message.slice(0, 80) : '未知错误'}），以下为结构化数据结论。`, '',
        `- 分析范围：${span}`,
        `- 阅读人数变化：${trend.readerChangePercent}%`,
        `- 完读率最低：${trend.lowestFinishRate.chapter}（${trend.lowestFinishRate.rate}）`,
        `- 追更流失章节：${trend.chaptersLosingFollowers.map((c: any) => `${c.chapter}（${c.netFollow7d}）`).join('、') || '无'}`,
      ].join('\n');
    }
    await ctx.finishStep(`报告 ${markdown.length} 字`);
    return markdown;
  });
}
