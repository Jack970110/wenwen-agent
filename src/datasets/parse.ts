/**
 * 数据文件解析与归一化（纯函数，无副作用）：
 * CSV（UTF-8/GBK 探测）或 xlsx → 行数组 → 表头自动映射 → 逐行校验归一化。
 * 错误（阻断导入）和警告（放行但提示）分开返回，行号精确到 1-based 数据行。
 *
 * 必填维度：章节序号/标题/阅读人数/完读率。
 * 可选维度：净增追更/发布日期/字数/评论数/差评率/收入——有哪列分析哪个维度。
 */
import * as XLSX from 'xlsx';

export const FIELDS = ['chapterId', 'title', 'readers', 'finishRate', 'netFollow', 'publishedAt', 'wordCount', 'comments', 'negativeRate', 'income'] as const;
export type FieldKey = (typeof FIELDS)[number];

export const FIELD_LABEL: Record<FieldKey, string> = {
  chapterId: '章节序号',
  title: '章节标题',
  readers: '阅读人数',
  finishRate: '完读率',
  netFollow: '净增追更',
  publishedAt: '发布日期',
  wordCount: '字数',
  comments: '评论数',
  negativeRate: '差评率',
  income: '收入(元)',
};

/** 必填字段：缺映射则无法导入 */
const REQUIRED: FieldKey[] = ['chapterId', 'title', 'readers', 'finishRate'];

/** 表头关键词自动映射：按优先级匹配，敢猜，猜不中留给用户手动调 */
const AUTO_MAP: [FieldKey, RegExp][] = [
  ['chapterId', /^(章节序号|章节编号|章节|序号|编号|chapter(\s*id)?|id)$/i],
  ['title', /标题|章节名|题目|title|name/i],
  ['readers', /阅读人数|读者数|阅读量|阅读|readers|uv$/i],
  ['finishRate', /完读率|读完率|finish|completion/i],
  ['netFollow', /净增追更|追更|净增|follow/i],
  ['comments', /评论数|评论量|评论|comment/i],
  ['negativeRate', /差评率|负评率|差评|negative/i],
  ['income', /收入|收益|稿费|income|revenue/i],
  ['publishedAt', /日期|发布|时间|date|time/i],
  ['wordCount', /字数|word/i],
];

export type Mapping = Partial<Record<FieldKey, number>>; // 字段 → 列下标

/** 解码 CSV：UTF-8 失败则试 GBK（国内导出常见），都不行退 UTF-8 忽略错误 */
function decodeCsvText(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    try {
      return new TextDecoder('gbk').decode(bytes);
    } catch {
      return new TextDecoder('utf-8').decode(bytes);
    }
  }
}

/** 统一入口：按文件类型解析成二维数组（首行表头）。xlsx 走 SheetJS */
export function parseDataFile(buf: ArrayBuffer, filename: string): string[][] {
  if (/\.xlsx?$/i.test(filename)) {
    const wb = XLSX.read(buf, { type: 'array' });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, blankrows: false, defval: '' });
    return rows.map((r) => (r as unknown[]).map((c) => String(c ?? '').trim()));
  }
  return parseCsv(decodeCsvText(buf));
}

/** RFC4180 简化实现：支持引号包裹、双引号转义、逗号/换行分隔 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; }
        else inQuotes = false;
      } else cell += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(cell.trim()); cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell.trim()); cell = '';
      if (row.some((c) => c !== '')) rows.push(row); // 空行跳过
      row = [];
    } else cell += ch;
  }
  row.push(cell.trim());
  if (row.some((c) => c !== '')) rows.push(row);
  return rows;
}

export function autoMap(headers: string[]): Mapping {
  const mapping: Mapping = {};
  const used = new Set<number>();
  for (const [field, re] of AUTO_MAP) {
    const idx = headers.findIndex((h, i) => !used.has(i) && re.test(h));
    if (idx >= 0) {
      mapping[field] = idx;
      used.add(idx);
    }
  }
  return mapping;
}

export interface StatRow {
  chapterId: number;
  title: string;
  readers7d: number;
  finishRate7d: number;
  netFollow7d?: number;
  publishedAt?: string;
  wordCount?: number;
  comments?: number;
  negativeRate?: number;
  income?: number;
}

export interface NormalizeResult {
  rows: StatRow[];
  warnings: string[];
  errors: string[];
}

function num(v: string): number | null {
  if (v === '') return null;
  const n = Number(v.replace(/[,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
}

/** 归一化 + 校验。返回 errors 非空则不可导入；warnings 只提示不拦截 */
export function normalize(rows: string[][], mapping: Mapping, opts: { maxRows: number }): NormalizeResult {
  const warnings: string[] = [];
  const errors: string[] = [];
  const out: StatRow[] = [];

  for (const f of REQUIRED) {
    if (mapping[f] === undefined) errors.push(`缺少必填列映射：${FIELD_LABEL[f]}`);
  }
  if (errors.length) return { rows: [], warnings, errors };

  const seen = new Set<number>();
  for (let i = 1; i < rows.length; i++) {
    const dataLine = i; // rows[0] 是表头，数据行号 = i
    if (out.length >= opts.maxRows) {
      errors.push(`行数超过上限 ${opts.maxRows}，请拆分文件`);
      break;
    }
    const cells = rows[i];
    const get = (f: FieldKey) => {
      const idx = mapping[f];
      return idx === undefined ? '' : (cells[idx] ?? '');
    };

    const chapterId = num(get('chapterId'));
    if (chapterId === null || !Number.isInteger(chapterId) || chapterId < 1) {
      errors.push(`第 ${dataLine} 行：章节序号「${get('chapterId')}」不是正整数`);
      continue;
    }
    if (seen.has(chapterId)) {
      warnings.push(`第 ${dataLine} 行：章节序号 ${chapterId} 重复，后值覆盖前值`);
    }
    seen.add(chapterId);

    const title = get('title');
    if (!title) {
      errors.push(`第 ${dataLine} 行：章节标题为空`);
      continue;
    }

    const readers = num(get('readers'));
    if (readers === null || readers < 0) {
      errors.push(`第 ${dataLine} 行：阅读人数「${get('readers')}」不是非负数`);
      continue;
    }

    let finishRate = num(get('finishRate'));
    if (finishRate === null) {
      errors.push(`第 ${dataLine} 行：完读率「${get('finishRate')}」不是数字`);
      continue;
    }
    if (finishRate > 1 && finishRate <= 100) {
      finishRate = finishRate / 100; // 百分数自动转小数
      warnings.push(`第 ${dataLine} 行：完读率按百分数自动转为了小数（${finishRate.toFixed(2)}）`);
    }
    if (finishRate < 0 || finishRate > 1) {
      errors.push(`第 ${dataLine} 行：完读率 ${finishRate} 超出 0~1 范围`);
      continue;
    }

    let negativeRate = num(get('negativeRate'));
    if (negativeRate !== null && negativeRate > 1 && negativeRate <= 100) {
      negativeRate = negativeRate / 100; // 百分数自动转小数
    }
    if (negativeRate !== null && (negativeRate < 0 || negativeRate > 1)) {
      errors.push(`第 ${dataLine} 行：差评率 ${negativeRate} 超出 0~1 范围`);
      continue;
    }

    const netFollow = num(get('netFollow'));
    const wordCount = num(get('wordCount'));
    const comments = num(get('comments'));
    const income = num(get('income'));
    const publishedAt = get('publishedAt') || undefined;

    out.push({
      chapterId,
      title,
      readers7d: readers,
      finishRate7d: finishRate,
      netFollow7d: netFollow ?? undefined,
      publishedAt,
      wordCount: wordCount ?? undefined,
      comments: comments ?? undefined,
      negativeRate: negativeRate ?? undefined,
      income: income ?? undefined,
    });
  }

  if (out.length > 0 && out[0].readers7d === 0) {
    errors.push('首章阅读人数为 0，无法计算阅读趋势（请检查数据）');
  }
  return { rows: out, warnings, errors };
}
