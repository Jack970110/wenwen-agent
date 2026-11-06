import { randomUUID } from 'node:crypto';
import { builtinDatasets } from '../mockData.js';
import { createDatasetRow, findDatasetByName, getChapterStatsRows, insertChapterStats, listDatasetRows, type DatasetRow } from '../db.js';
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
