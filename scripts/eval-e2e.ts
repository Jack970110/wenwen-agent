import { readFileSync } from 'node:fs';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { generateText } from 'ai';
import 'dotenv/config';

/**
 * 端到端事实性评测（RAG 链路第③层）：
 *   问题 → /api/chat 完整链路（检索+组装+生成）→ 回答 → LLM-as-judge 核对事实点
 * 用法：先启动服务（npm run server），再 npx tsx scripts/eval-e2e.ts
 *
 * 判定原则：只核对事实点真伪，不评文风/结构/完整性——判定标准越窄越抗模型不确定性。
 * judge 用独立模型档（MODEL_JUDGE，默认 glm-4.7-flash），与被测主模型隔离。
 */

const BASE = 'http://localhost:3001';
let cookie = '';

async function api(path: string, init: RequestInit = {}) {
  const res = await fetch(BASE + path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}), ...(init.headers || {}) },
  });
  const jar = new Map<string, string>(cookie ? cookie.split('; ').map((c) => [c.split('=')[0], c]) : []);
  for (const line of res.headers.getSetCookie?.() ?? []) {
    const kv = line.split(';')[0];
    if (kv.includes('=')) jar.set(kv.split('=')[0], kv);
  }
  cookie = [...jar.values()].join('; ');
  return res;
}

async function ask(question: string, focusNovel: string): Promise<string> {
  const s = await (await api('/api/sessions', { method: 'POST', body: '{}' })).json();
  const sid = s.sessionId ?? s.id;
  await api(`/api/sessions/${sid}/focus`, { method: 'PATCH', body: JSON.stringify({ novelTitle: focusNovel }) });
  const chat = await api('/api/chat', { method: 'POST', body: JSON.stringify({ sessionId: sid, message: question, deep: false }) });
  if (!chat.ok) throw new Error(`chat HTTP ${chat.status}`);
  const reader = chat.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '', answer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      for (const line of frame.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        try {
          const evt = JSON.parse(line.slice(6));
          if (evt.type === 'text-delta') answer += evt.text;
        } catch { /* 忽略半帧 */ }
      }
    }
  }
  return answer;
}

const zhipu = createOpenAICompatible({ name: 'zhipu', baseURL: 'https://open.bigmodel.cn/api/paas/v4', apiKey: process.env.ZHIPU_API_KEY });

interface Verdict { point: string; hit: boolean; evidence: string }

async function judge(question: string, points: string[], answer: string): Promise<Verdict[]> {
  const result = await generateText({
    model: zhipu(process.env.MODEL_JUDGE || 'glm-4.7-flash'),
    maxRetries: 2,
    system:
      '你是评测裁判。给定「问题」「事实点清单」「回答」，逐个事实点判定回答中是否包含该事实（同义表述算命中）。' +
      '只判事实真伪：回答没提到该事实 = miss；提到了但与事实点矛盾 = miss。不评文风、完整性、准确性之外的任何维度。' +
      '严格输出 JSON 数组，不要多余文字：[{"point":"事实点原文","hit":true/false,"evidence":"回答中的原文依据（≤30字）或缺失原因"}]',
    prompt: JSON.stringify({ 问题: question, 事实点: points, 回答: answer.slice(0, 3000) }),
  });
  return JSON.parse(result.text.replace(/^```json?\s*|```$/g, '').trim());
}

async function main() {
  const evalSet = JSON.parse(readFileSync('data/eval-e2e.json', 'utf-8'));
  const cases: { q: string; points: string[] }[] = evalSet.cases;
  const focusNovel = process.argv[2] || '绍宋';

  // 管理员登录（focus 绑定需要 admin）
  const first = (process.env.ADMIN_USERS || '').split(',')[0];
  const [user, pass] = first.split(':');
  await api('/api/login', { method: 'POST', body: JSON.stringify({ username: user, password: pass }) });

  console.log(`端到端事实性评测：${cases.length} 题（focus=${focusNovel}，judge=${process.env.MODEL_JUDGE || 'glm-4.7-flash'}）\n`);
  let pointTotal = 0, pointHit = 0, casePass = 0;

  for (const c of cases) {
    let answer = '', error = '';
    try { answer = await ask(c.q, focusNovel); } catch (e) { error = e instanceof Error ? e.message : String(e); }
    if (error) { console.log(`⚠️ ${c.q}\n   调用失败: ${error}\n`); continue; }

    let verdicts: Verdict[];
    try { verdicts = await judge(c.q, c.points, answer); }
    catch (e) { console.log(`⚠️ ${c.q}\n   judge 解析失败: ${e instanceof Error ? e.message : e}\n`); continue; }

    const hits = verdicts.filter((v) => v.hit).length;
    const allHit = hits === c.points.length;
    pointTotal += c.points.length;
    pointHit += hits;
    if (allHit) casePass++;
    console.log(`${allHit ? '✅' : '⚠️ '} ${c.q}`);
    for (const v of verdicts) {
      console.log(`   ${v.hit ? '✓' : '✗'} [${v.point}] ${v.evidence}`);
    }
    console.log();
  }

  console.log('──────────────');
  console.log(`案例全过率: ${casePass}/${cases.length} = ${((casePass / cases.length) * 100).toFixed(0)}%`);
  console.log(`事实点命中率: ${pointHit}/${pointTotal} = ${((pointHit / pointTotal) * 100).toFixed(0)}%`);
}

main().catch((err) => { console.error('❌ 评测失败:', err.message); process.exit(1); });
