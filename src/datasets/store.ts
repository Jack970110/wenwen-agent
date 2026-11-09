import { randomUUID } from 'node:crypto';
import { builtinDatasets } from '../mockData.js';
import { createDatasetRow, findDatasetByName, getChapterStatsRows, insertChapterStats, listDatasetRows, type DatasetRow, type StatRow } from '../db.js';
import { getNovelByTitle, getChapterTextRows } from '../rag/store.js';
export { findDatasetByName } from '../db.js';

/**
 * 数据集服务层：种子数据 + 查询封装。
 * 上传/删除的编排放在 server.ts 路由层（涉及 multipart 解析），
 * 这里只收纯数据操作。
 */

/** 内置演示数据集：幂等 seed（按名字查不到才插），owner=public 供未来游客场景 */
export function seedBuiltinDatasets(): void {
  for (const [name, rows] of Object.entries(builtinDatasets)) {
    if (findDatasetByName(name)) continue;
    const id = `DS-${randomUUID().slice(0, 8).toUpperCase()}`;
    createDatasetRow(id, name, 'public', rows.length);
    insertChapterStats(id, rows);
  }
}

/* ---- 《绍宋》合成阅读数据（游客冷启动）---- */

/** 剧情事件曲线：高潮区阅读上扬，转折/低谷区完读率下滑——让报告有戏可归因 */
const READERS_BOOST: [number, number, number][] = [
  [36, 38, 0.15], [48, 50, 0.22], [58, 60, 0.18], [215, 216, 0.15], [356, 358, 0.2],
];
const FINISH_ADJ: [number, number, number][] = [
  [26, 28, -0.12], [31, 31, -0.15], [44, 46, -0.1], [51, 53, -0.12], [62, 63, 0.05],
];

function syntheticStats(chapterLabels: string[], chapterChars: number[]): StatRow[] {
  return chapterLabels.map((title, i) => {
    const no = i + 1;
    const boost = READERS_BOOST.filter(([a, b]) => no >= a && no <= b).reduce((s, [, , v]) => s + v, 0);
    const finishAdj = FINISH_ADJ.filter(([a, b]) => no >= a && no <= b).reduce((s, [, , v]) => s + v, 0);
    const readers7d = Math.max(
      1000,
      Math.round(68000 * Math.exp(-no * 0.0022) * (1 + boost) + Math.sin(no * 1.7) * 400),
    );
    const finishRate7d = Math.min(0.93, Math.max(0.62, 0.87 + Math.sin(no / 9) * 0.02 + finishAdj));
    const netFollow7d = Math.round((finishRate7d - 0.82) * 500 + Math.sin(no * 2.3) * 150);
    const d = new Date('2026-09-01T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + no * 2);
    return {
      chapterId: no,
      title,
      readers7d,
      finishRate7d: Math.round(finishRate7d * 100) / 100,
      netFollow7d,
      publishedAt: d.toISOString().slice(0, 10),
      wordCount: chapterChars[i],
    };
  });
}

/**
 * 《绍宋》合成阅读数据 seed（游客冷启动）：
 * 章节清单与字数取自知识库真实 chunks，阅读指标由确定性公式合成「剧情事件曲线」
 * ——高潮章（雪渡/水战/元宵）数据上扬，转折章（杀刘光世/勤王文书）完读率下滑，
 * 报告有戏剧性可归因。注意：非真实运营数据，仅供演示。
 * 名字「绍宋-阅读数据」经 resolveDataset 归一化可自动匹配同名小说（交叉归因联动）。
 * 绍宋未入库时跳过——新环境先入库书，重启服务即补 seed。
 */
export function seedShaosongDataset(): void {
  const NAME = '绍宋-阅读数据';
  if (findDatasetByName(NAME)) return;
  const novel = getNovelByTitle('绍宋');
  if (!novel) return;
  const textRows = getChapterTextRows(novel.id);
  if (!textRows.length) return;

  const strip = (t: string) => {
    const nl = t.indexOf('\n');
    return nl > 0 && /^\[(全书第|第\d+段)/.test(t.slice(0, nl)) ? t.slice(nl + 1) : t;
  };
  const seen = new Set<string>();
  const order: string[] = [];
  const chars: number[] = [];
  for (const r of textRows) {
    const body = strip(r.text).replace(/\s+/g, '').length;
    if (!seen.has(r.chapter)) { seen.add(r.chapter); order.push(r.chapter); chars.push(0); }
    chars[chars.length - 1] += body;
  }

  const statRows = syntheticStats(order, chars);
  const id = `DS-${randomUUID().slice(0, 8).toUpperCase()}`;
  createDatasetRow(id, NAME, 'public', statRows.length);
  insertChapterStats(id, statRows);
  console.log(`[seed] 合成阅读数据集「${NAME}」已生成（${statRows.length} 章，公开）`);
}

export function listDatasets(owner: string): DatasetRow[] {
  return listDatasetRows(owner);
}

/** 按名字取数据（dataService 的数据入口；名字不存在返回 undefined 让上层明确报错） */
export function getStatsByName(name: string) {
  const ds = findDatasetByName(name);
  if (!ds) return undefined;
  return { dataset: ds, rows: getChapterStatsRows(ds.id) };
}

/** 兜底：不带书名时用最新一个数据集（保持 MCP/工具老调用的行为） */
export function getLatestStats() {
  const all = listDatasets('public');
  if (!all.length) return undefined;
  return { dataset: all[0], rows: getChapterStatsRows(all[0].id) };
}
