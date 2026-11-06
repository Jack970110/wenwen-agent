import { getLatestStats, getStatsByName, listDatasets, findDatasetByName } from './datasets/store.js';

/**
 * 数据服务层：纯业务逻辑，不关心调用方是谁。
 * Function Calling（tools.ts）和 MCP Server（mcp-server.ts）都复用这一层——
 * 这就是"工具能力服务化"的第一步：逻辑和协议解耦。
 *
 * 数据从 datasets/chapter_stats 表读取（内置演示数据集启动时 seed，
 * 用户上传的 CSV 走同一张表）——数据来源对调用方透明。
 */

export function queryChaptersData(fromChapterId: number, toChapterId?: number, novelTitle?: string) {
  const to = toChapterId ?? fromChapterId;
  const src = novelTitle ? getStatsByName(novelTitle) : getLatestStats();
  if (!src) return { error: `没有名为「${novelTitle}」的数据集` };
  return src.rows.filter((c) => c.chapterId >= fromChapterId && c.chapterId <= to);
}

export function analyzeTrendData(fromChapterId: number, toChapterId: number, novelTitle?: string) {
  const src = novelTitle ? getStatsByName(novelTitle) : getLatestStats();
  if (!src) return { error: `没有名为「${novelTitle}」的数据集` };
  const list = src.rows.filter((c) => c.chapterId >= fromChapterId && c.chapterId <= toChapterId);
  if (list.length === 0) return { error: '区间内无数据' };

  const byFinish = [...list].sort((a, b) => a.finishRate7d - b.finishRate7d);
  const dropFollow = list.filter((c) => (c.netFollow7d ?? 0) < 0);
  const first = list[0];
  const last = list[list.length - 1];
  const readerTrend = first.readers7d === 0 ? 0 : ((last.readers7d - first.readers7d) / first.readers7d) * 100;

  const result: Record<string, unknown> = {
    lowestFinishRate: { chapter: byFinish[0].title, rate: byFinish[0].finishRate7d },
    highestFinishRate: { chapter: byFinish[byFinish.length - 1].title, rate: byFinish[byFinish.length - 1].finishRate7d },
    chaptersLosingFollowers: dropFollow.map((c) => ({ chapter: c.title, netFollow7d: c.netFollow7d })),
    readerChangePercent: Number(readerTrend.toFixed(1)),
  };

  /* 可选维度：有数据才分析（多维数据的差异发现） */
  const extra: string[] = [];

  if (list.some((c) => c.wordCount)) {
    // 章节长度 vs 完读率：找完读率最低三节的平均字数 vs 全书平均，差异显著则提示
    const withLen = list.filter((c) => c.wordCount);
    const avgLen = withLen.reduce((s, c) => s + (c.wordCount ?? 0), 0) / withLen.length;
    const bottom3 = byFinish.slice(0, 3);
    const bottomAvgLen = bottom3.reduce((s, c) => s + (c.wordCount ?? 0), 0) / bottom3.length;
    if (avgLen > 0 && bottomAvgLen / avgLen > 1.15) {
      extra.push(`完读率最低 3 章平均字数 ${Math.round(bottomAvgLen)}，显著高于全书平均 ${Math.round(avgLen)}——完读率下滑可能与章节过长有关`);
    }
  }

  if (list.some((c) => c.comments != null)) {
    // 评论率（评论数/阅读人数）异常：找最高和最低，低于均值一半的进发现
    const withC = list.filter((c) => c.comments != null && c.readers7d > 0);
    const avgRatio = withC.reduce((s, c) => s + (c.comments! / c.readers7d), 0) / withC.length;
    const low = withC.filter((c) => c.comments! / c.readers7d < avgRatio / 2).map((c) => c.title);
    extra.push(`平均评论率 ${(avgRatio * 100).toFixed(1)}%${low.length ? `；互动冷清章节：${low.join('、')}` : '，各章互动水平均衡'}`);
  }

  if (list.some((c) => c.negativeRate != null)) {
    const worst = [...list].filter((c) => c.negativeRate != null).sort((a, b) => (b.negativeRate ?? 0) - (a.negativeRate ?? 0))[0];
    extra.push(`差评率最高：${worst.title}（${((worst.negativeRate ?? 0) * 100).toFixed(1)}%）`);
  }

  if (list.some((c) => c.income != null)) {
    // 收入环比：找跌幅最大的相邻章节对
    let worstDrop: { from: string; to: string; pct: number } | null = null;
    for (let i = 1; i < list.length; i++) {
      const prev = list[i - 1].income, cur = list[i].income;
      if (prev && cur != null && prev > 0) {
        const pct = ((cur - prev) / prev) * 100;
        if (!worstDrop || pct < worstDrop.pct) worstDrop = { from: list[i - 1].title, to: list[i].title, pct };
      }
    }
    const total = (last.income ?? 0), start = (first.income ?? 0);
    extra.push(`收入整体变化 ${start > 0 ? (((total - start) / start) * 100).toFixed(1) : '—'}%${worstDrop ? `；最大单章跌幅：${worstDrop.from} → ${worstDrop.to}（${worstDrop.pct.toFixed(1)}%）` : ''}`);
  }

  if (extra.length) result.extraFindings = extra;
  return result;
}

/**
 * 为小说解析关联的阅读数据集（novelAnalysis 交叉归因用）。
 * 方案 A 显式绑定优先：用户在 UI 选了 datasetName 就校验后采用，选错宁可不关联。
 * 方案 B 兜底（保守自动匹配）：只有「归一化后相等」或「一方包含另一方」两种命中，
 * 且要求候选唯一——匹配是猜的，宁可漏配不错配；没命中返回 undefined（纯文本分析）。
 */
export function resolveDataset(
  novelTitle: string,
  owner: string,
  explicit?: string,
): { name: string; how: 'explicit' | 'auto' } | undefined {
  if (explicit) {
    const ds = findDatasetByName(explicit);
    return ds ? { name: ds.name, how: 'explicit' } : undefined;
  }
  const norm = (s: string) => s.replace(/(阅读数据|数据集|数据|阅读)/g, '').replace(/[-_—·\s]+/g, '');
  const datasets = listDatasets(owner);
  const candidates = datasets.filter((d) => {
    const n = norm(d.name), t = norm(novelTitle);
    return d.name === novelTitle || n === t || (t.length > 1 && n.includes(t)) || (n.length > 1 && t.includes(n));
  });
  return candidates.length === 1 ? { name: candidates[0].name, how: 'auto' } : undefined;
}

export function saveReportData(title: string, conclusions: string[], suggestions: string[]) {  const reportId = `RPT-${Date.now().toString(36).toUpperCase()}`;
  // v2 可以写入数据库 / 生成文件
  console.error(`📄 报告已生成 [${reportId}]: ${title}`); // 注意：MCP stdio 模式下 stdout 是协议通道，日志必须走 stderr
  return { reportId, saved: true };
}
