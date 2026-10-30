/**
 * 端到端问答复现：建会话 → 绑定 focus 绍宋 → 发起非深度问答 → 打印回答与注入证据。
 * 用法: npx tsx scripts/e2e-qa.ts ["问题"]
 */
import 'dotenv/config';

const BASE = 'http://localhost:3001';
let cookie = '';

async function api(path: string, init: RequestInit = {}) {
  const res = await fetch(BASE + path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}), ...(init.headers || {}) },
  });
  // 多个 Set-Cookie（visitor + auth）要合并保留，不能只取第一个
  const jar = new Map<string, string>(cookie ? cookie.split('; ').map((c) => [c.split('=')[0], c]) : []);
  for (const line of res.headers.getSetCookie?.() ?? []) {
    const kv = line.split(';')[0];
    if (kv.includes('=')) jar.set(kv.split('=')[0], kv);
  }
  cookie = [...jar.values()].join('; ');
  return res;
}

(async () => {
  // 0. 管理员登录（绍宋 owner=admin，游客无法聚焦）
  const first = (process.env.ADMIN_USERS || '').split(',')[0];
  const [user, pass] = first.split(':');
  const login = await api('/api/login', { method: 'POST', body: JSON.stringify({ username: user, password: pass }) });
  console.log('登录:', login.status);
  console.log('身份:', JSON.stringify(await (await api('/api/me')).json()));
  console.log('书目:', (await (await api('/api/novels')).json()).map((n: any) => n.title).join(', '));

  // 1. 建会话
  const s = await (await api('/api/sessions', { method: 'POST', body: '{}' })).json();
  const sid = s.sessionId ?? s.id;
  console.log('sessionId:', sid);
  // 2. 绑定 focus
  const f = await api(`/api/sessions/${sid}/focus`, { method: 'PATCH', body: JSON.stringify({ novelTitle: '绍宋' }) });
  console.log('focus 绑定:', f.status, await f.text());
  // 3. 发问（非深度），收集 SSE
  const q = process.argv[2] || '绍宋这本书讲了什么故事';
  const chat = await api('/api/chat', { method: 'POST', body: JSON.stringify({ sessionId: sid, message: q, deep: false }) });
  console.log('chat status:', chat.status);
  const reader = chat.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '', answer = '', tools: string[] = [];
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
          if (evt.type === 'tool-call') tools.push(`${evt.toolName}(${JSON.stringify(evt.args).slice(0, 60)})`);
          if (evt.type === 'text-delta') answer += evt.text;
        } catch { /* 忽略半帧 */ }
      }
    }
  }
  console.log('工具调用:', tools.length ? tools.join(' -> ') : '(无)');
  console.log('=== 回答 ===\n' + answer);
})();
