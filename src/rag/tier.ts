/**
 * 小说体量分级（T1-T4）：入库时按字数定级，查询时按级别路由。
 * 阈值依据见 README「小说体量分级标准」。分级影响处理管道，不影响存储引擎。
 * 阈值支持环境变量覆盖（测试/校准用）：TIER_T1_MAX / TIER_T2_MAX / TIER_T3_MAX
 */
export type Tier = 'T1' | 'T2' | 'T3' | 'T4';

function envNum(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

const T1_MAX = envNum('TIER_T1_MAX', 30_000);    // < 3 万字：全量塞上下文
const T2_MAX = envNum('TIER_T2_MAX', 200_000);   // < 20 万字：标准 RAG
const T3_MAX = envNum('TIER_T3_MAX', 1_000_000); // < 100 万字：+ 章摘要层

export function determineTier(totalChars: number): Tier {
  if (totalChars < T1_MAX) return 'T1';
  if (totalChars < T2_MAX) return 'T2';
  if (totalChars < T3_MAX) return 'T3';
  return 'T4';
}
