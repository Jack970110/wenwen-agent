import 'dotenv/config';
import { serve } from '@hono/node-server';
import { Hono, type Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import { setCookie, getCookie } from 'hono/cookie';
import { serveStatic } from '@hono/node-server/serve-static';
import { type ModelMessage, streamText } from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { runAgent } from './agent.js';
import { appendMessage, checkChatLimits, createSession, deleteSession, getMessages, listSessions, sessionExists, type StoredMessage } from './db.js';
import { chunkNovel } from './rag/chunker.js';
import { listNovels, deleteNovel, getNovelByTitle } from './rag/store.js';
import { getJob, startIngestJob } from './rag/ingestJob.js';
import { ragScope } from './rag/context.js';
import { checkPassword, getAdminUsers, makeToken, verifyToken, authEnabled } from './auth.js';

/** 深度模型直连（两阶段模式的阶段 2 用） */
const zhipuDeep = createOpenAICompatible({
  name: 'zhipu',
  baseURL: 'https://open.bigmodel.cn/api/paas/v4',
  apiKey: process.env.ZHIPU_API_KEY,
});

/**
 * 服务端 v2a：
 * - POST /api/chat    SSE 流式对话（核心接口）
 * - GET  /api/sessions 会话列表
 * - GET  /api/sessions/:id/messages 会话历史
 * - 静态托管 web/ 目录
 *
 * 协议设计：SSE event 的 data 是一行 JSON，type 字段区分事件：
 *   tool-call / tool-error / text-delta / done / error
 * 前端据此分别渲染"工具调用时间线"和"正文流"。
 */
const app = new Hono();

/** 身份解析：admin = 有效密码 cookie；guest = 匿名 visitorId cookie（首次访问自动种） */
app.use('*', async (c: Context, next) => {
  let visitorId = getCookie(c, 'visitor');
  if (!visitorId) {
    visitorId = crypto.randomUUID();
    setCookie(c, 'visitor', visitorId, { path: '/', maxAge: 60 * 60 * 24 * 365, sameSite: 'Lax' });
  }
  c.set('visitorId', visitorId);
  c.set('isAdmin', !!verifyToken(getCookie(c, 'auth')));
  await next();
});

/**
 * 访问密码鉴权（未配置 ACCESS_PASSWORD 时全部跳过）：
 * 分级权限——游客免登录可对话/管理自己的会话/读公开演示库；
 * 小说上传删除等管理操作需管理员 cookie。
 * 页面本身对游客开放（体验零门槛），登录页 /login 供管理员使用。
 */
if (authEnabled()) {
  app.use('/api/*', async (c: Context, next) => {
    if (c.req.path === '/api/login' || c.req.path === '/api/me') return next();
    if (c.get('isAdmin')) return next();
    // 游客可用：对话、会话（隔离到访客）、公开小说库读取；管理操作 401
    const guestAllowed = ['/api/chat', '/api/sessions', '/api/novels'].some((p) => c.req.path.startsWith(p))
      && !(c.req.method !== 'GET' && c.req.path.startsWith('/api/novels'));
    if (guestAllowed) return next();
    return c.json({ error: '需要管理员权限', needLogin: true }, 401);
  });
}

// 登录页（自包含单文件，无外部资源依赖）
app.get('/login', (c: Context) =>
  c.html(`<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>登录 · 问问 Agent</title><style>
body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;background:#0f1117;color:#e4e7ef;
font-family:-apple-system,"PingFang SC",sans-serif}
.card{width:340px;background:#171a23;border:1px solid #2a2f3f;border-radius:14px;padding:28px}
h1{font-size:17px;margin:0 0 6px}p{font-size:12px;color:#8b93a7;margin:0 0 18px}
input{width:100%;box-sizing:border-box;background:#0f1117;border:1px solid #2a2f3f;border-radius:8px;
padding:10px 12px;color:#e4e7ef;font:inherit;outline:none;margin-bottom:10px}
input:focus{border-color:#6c8cff}
button{width:100%;margin-top:14px;padding:10px;border:none;border-radius:8px;cursor:pointer;color:#fff;
background:linear-gradient(135deg,#6c8cff,#8b6cff);font-size:14px}
.err{color:#f87171;font-size:12px;margin-top:10px;min-height:16px}
</style></head><body><div class="card">
<h1>问问 Agent</h1><p>私有部署站点，管理员登录</p>
<input type="text" id="user" placeholder="用户名" autofocus>
<input type="password" id="pw" placeholder="密码">
<div class="err" id="err"></div>
<button onclick="login()">进入</button>
</div><script>
async function login(){
  const u=document.getElementById('user').value.trim(), p=document.getElementById('pw').value;
  const r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:u,password:p})});
  if(r.ok){location.href='/'}else{document.getElementById('err').textContent='用户名或密码错误'}
}
for(const id of ['user','pw'])document.getElementById(id).addEventListener('keydown',e=>{if(e.key==='Enter')login()});
</script></body></html>`),
);

app.post('/api/login', async (c: Context) => {
  const { username, password } = (await c.req.json()) as { username?: string; password?: string };
  if (!username?.trim() || !checkPassword(username.trim(), password ?? '')) {
    return c.json({ error: '用户名或密码错误' }, 401);
  }
  setCookie(c, 'auth', makeToken(username.trim()), {
    httpOnly: true, sameSite: 'Lax', path: '/', maxAge: 60 * 60 * 24 * 30, // 30 天
  });
  return c.json({ ok: true, username: username.trim() });
});

// httpOnly cookie 只能由服务端清除
app.post('/api/logout', (c: Context) => {
  setCookie(c, 'auth', '', { httpOnly: true, sameSite: 'Lax', path: '/', maxAge: 0 });
  return c.json({ ok: true });
});

app.get('/api/me', (c: Context) => c.json({ admin: c.get('isAdmin') as boolean, username: verifyToken(getCookie(c, 'auth')) }));

app.post('/api/chat', async (c: Context) => {
  // 防薅：全站日限额 + 单 IP 限频（游客和管理员都受限，额度是站点级成本护栏）
  const ip = c.req.header('x-forwarded-for')?.split(',')[0].trim() || 'local';
  const limit = checkChatLimits(ip);
  if (!limit.allowed) return c.json({ error: limit.reason }, 429);

  const { sessionId, message, novelTitle, deep } = (await c.req.json()) as {
    sessionId: string;
    message: string;
    novelTitle?: string;
    deep?: boolean;
  };
  if (!sessionId || !message?.trim()) {
    return c.json({ error: 'sessionId 和 message 必填' }, 400);
  }
  // 会话按身份隔离：游客用 visitorId，管理员用 'admin'
  const visitorId = c.get('visitorId') as string;
  const owner = c.get('isAdmin') ? 'admin' : visitorId;
  if (!sessionExists(sessionId, owner)) {
    return c.json({ error: '会话不存在' }, 404);
  }
  // 前端选择器传入的聚焦小说：游客只能聚焦公开演示库；不存在时忽略（退化为全库检索）
  const focusNovel = novelTitle && getNovelByTitle(novelTitle) ? novelTitle : undefined;
  const focus = c.get('isAdmin') ? focusNovel : (getNovelByTitle(focusNovel ?? '')?.owner === 'public' ? focusNovel : undefined);

  const userMsg: StoredMessage = {
    id: crypto.randomUUID(),
    role: 'user',
    parts: [{ type: 'text', text: message.trim() }],
  };
  appendMessage(sessionId, owner, userMsg);
  const rawHistory = getMessages(sessionId, owner);

  // 历史卫生：正常序列必须 user/assistant 交替。
  // 回答被停止或失败时会留下"悬空提问"（连续两条 user），小模型会被带偏。
  // 策略：只保留最后一条悬空提问（即本轮），丢弃更早的。
  const history: StoredMessage[] = [];
  for (const m of rawHistory) {
    if (m.role === 'user' && history[history.length - 1]?.role === 'user') {
      history.pop();
    }
    history.push(m);
  }

  // 滑窗截断：上下文窗口有限（glm-4-flash 128K），单会话聊太长会直接超限报错。
  // 只保留最近 MAX_CONTEXT_MESSAGES 条；截断后首条若是 assistant（对话 API 要求
  // 首条为 user）则继续丢弃，保证序列合法。历史消息不会丢——库里还有完整版。
  const MAX_CONTEXT_MESSAGES = 20;
  let context = history.slice(-MAX_CONTEXT_MESSAGES);
  while (context.length && context[0].role !== 'user') context = context.slice(1);

  // 防御：任何情况下发给模型的消息都不能为空
  if (context.length === 0) context = [userMsg];

  // 客户端断开（关页面/点停止）→ abortController 触发 → streamText 取消上游请求
  // 不取消的话模型会继续生成，token 照烧
  const abortController = new AbortController();
  c.req.raw.signal.addEventListener('abort', () => abortController.abort());

  // 游客的检索边界：只扫公开演示库（通过 ALS 透传到工具执行层）
  const onlyPublic = !c.get('isAdmin');

  return streamSSE(c, async (stream) => {
    let assistantText = '';
    // 本轮工具调用记录：随回答一起持久化，前端回看时可还原时间线
    const toolEvents: { name: string; args: string; error?: boolean }[] = [];
    let errored = false;
    try {
      // 存储消息转模型消息：只保留 text part（工具记录是给人看的，不进模型上下文）
      const modelInput = context.map((m) => ({
        role: m.role,
        content: m.parts.filter((p: StoredMessage['parts'][number]) => p.type === 'text').map((p) => p.text).join(''),
      }));

      const sendEvent = (evt: Record<string, unknown>) => stream.writeSSE({ data: JSON.stringify(evt) });

      await ragScope.run({ onlyPublic }, async () => {
        if (deep) {
        /**
         * 两阶段深度模式（绕过智谱 Z1 流式工具调用的接口缺陷）：
         * 阶段 1：快模型跑 Agent loop 完成工具调用/检索（此链路稳定），收集检索结果
         * 阶段 2：Z1 不带工具，基于资料做纯推理合成——"廉价模型检索、强模型合成"
         */
        await sendEvent({ type: 'status', message: '检索资料中…' });
        const fast = runAgent(modelInput as ModelMessage[], abortController.signal, focus, { retrievalOnly: true });
        const toolResults: { name: string; output: string }[] = [];
        for await (const part of fast.fullStream) {
          if (part.type === 'tool-call') {
            toolEvents.push({ name: part.toolName, args: JSON.stringify(part.input) });
            await sendEvent({ type: 'tool-call', toolName: part.toolName, args: part.input });
          } else if (part.type === 'tool-error') {
            toolEvents.push({ name: part.toolName, args: String(part.input ?? ''), error: true });
            await sendEvent({ type: 'tool-error', toolName: part.toolName, error: String(part.error) });
          } else if (part.type === 'tool-result') {
            toolResults.push({ name: part.toolName, output: JSON.stringify(part.output).slice(0, 6000) });
          }
        }

        await sendEvent({ type: 'status', message: '深度思考中…' });
        const deepStart = Date.now();
        let firstDeltaAt = 0;
        let deltaCount = 0;
        const context = toolResults.length
          ? toolResults.map((r) => `[${r.name} 检索结果]\n${r.output}`).join('\n\n')
          : '（本轮没有检索到资料，若问题涉及小说内容请如实说明未找到）';
        const deepResult = streamText({
          model: zhipuDeep(process.env.MODEL_DEEP || 'glm-z1-flash'),
          system: `你是深度分析助手。基于提供的检索资料深度思考后回答用户最后的问题。要求：提炼归纳、标注书名和章节出处、资料里没有的内容不编造、资料不足时如实说明。`,
          messages: [
            ...modelInput,
            { role: 'assistant', content: `[已完成的检索资料]\n${context}` },
            { role: 'user', content: '请基于以上检索资料，深度思考后回答我之前的问题。' },
          ],
          abortSignal: abortController.signal,
          maxRetries: 5,
        });
        for await (const part of deepResult.fullStream) {
          if (part.type === 'reasoning-delta') {
            if (!firstDeltaAt) firstDeltaAt = Date.now();
            deltaCount++;
            await sendEvent({ type: 'reasoning-delta', text: part.text });
          } else if (part.type === 'text-delta') {
            if (!firstDeltaAt) firstDeltaAt = Date.now();
            deltaCount++;
            assistantText += part.text;
            await sendEvent({ type: 'text-delta', text: part.text });
          }
        }
        console.log(
          `[deep] Z1 阶段2: delta=${deltaCount} 个, 首个 delta 延迟 ${firstDeltaAt ? firstDeltaAt - deepStart : '-'}ms, 生成总耗时 ${Date.now() - deepStart}ms` +
          (deltaCount > 1 && firstDeltaAt ? `（若首延迟 ≪ 总耗时则为真流式）` : ''),
        );
      } else {
        const result = runAgent(modelInput as ModelMessage[], abortController.signal, focus);

        for await (const part of result.fullStream) {
          if (part.type === 'tool-call') {
            toolEvents.push({ name: part.toolName, args: JSON.stringify(part.input) });
            await sendEvent({ type: 'tool-call', toolName: part.toolName, args: part.input });
          } else if (part.type === 'tool-error') {
            toolEvents.push({ name: part.toolName, args: String(part.input ?? ''), error: true });
            await sendEvent({ type: 'tool-error', toolName: part.toolName, error: String(part.error) });
          } else if (part.type === 'text-delta') {
            assistantText += part.text;
            await sendEvent({ type: 'text-delta', text: part.text });
          }
        }
      }
      }); // ragScope.run：工具执行层的检索边界只在请求作用域内生效

      appendMessage(sessionId, owner, {
        id: crypto.randomUUID(),
        role: 'assistant',
        parts: [
          ...toolEvents.map((t) => ({ type: 'tool' as const, name: t.name, args: t.args, error: t.error })),
          { type: 'text', text: assistantText },
        ],
      });
      await stream.writeSSE({ data: JSON.stringify({ type: 'done' }) });
    } catch (err) {
      // 客户端主动断开不算错误，静默结束即可
      if (abortController.signal.aborted) {
        // 即使没有生成任何文字也要落库占位，否则历史里会留下悬空提问污染后续对话
        appendMessage(sessionId, owner, {
          id: crypto.randomUUID(),
          role: 'assistant',
          parts: [
            ...toolEvents.map((t) => ({ type: 'tool' as const, name: t.name, args: t.args, error: t.error })),
            { type: 'text', text: (assistantText || '（已停止生成）') + '' },
          ],
        });
        await stream.writeSSE({ data: JSON.stringify({ type: 'done', stopped: true }) });
        return;
      }
      errored = true;
      const msg = err instanceof Error ? err.message : String(err);
      const friendly = msg.includes('Insufficient Balance') || msg.includes('402')
        ? '模型账户余额不足，请充值后重试'
        : msg.includes('访问量过大') || msg.includes('1305') || msg.includes('429') || msg.toLowerCase().includes('rate')
          ? '免费模型当前限流（高峰期访问量大），请稍等几秒重试'
          : `请求失败: ${msg.slice(0, 200)}`;
      // 失败同样落库占位，保持 user/assistant 交替
      appendMessage(sessionId, owner, {
        id: crypto.randomUUID(),
        role: 'assistant',
        parts: [{ type: 'text', text: `（生成失败：${friendly}）` }],
      });
      await stream.writeSSE({ data: JSON.stringify({ type: 'error', message: friendly }) });
    } finally {
      void errored;
    }
  });
});

app.get('/api/sessions', (c: Context) => {
  const owner = c.get('isAdmin') ? 'admin' : (c.get('visitorId') as string);
  return c.json(listSessions(owner));
});

app.get('/api/sessions/:id/messages', (c: Context) => {
  const owner = c.get('isAdmin') ? 'admin' : (c.get('visitorId') as string);
  return c.json(getMessages(c.req.param('id') as string, owner));
});

app.post('/api/sessions', (c: Context) => {
  const owner = c.get('isAdmin') ? 'admin' : (c.get('visitorId') as string);
  return c.json({ sessionId: createSession(owner) });
});

app.delete('/api/sessions/:id', (c: Context) => {
  const owner = c.get('isAdmin') ? 'admin' : (c.get('visitorId') as string);
  return c.json({ ok: deleteSession(c.req.param('id') as string, owner) });
});

app.get('/api/sessions', (c: Context) => {
  const owner = c.get('isAdmin') ? 'admin' : (c.get('visitorId') as string);
  return c.json(listSessions(owner));
});

/** 小说库：游客读公开演示库；上传/删除是管理员操作 */
app.get('/api/novels', (c: Context) => c.json(listNovels(c.get('isAdmin') ? 'admin' : 'guest')));

app.post('/api/novels', async (c: Context) => {
  if (!c.get('isAdmin')) return c.json({ error: '需要管理员权限', needLogin: true }, 401);
  const body = await c.req.parseBody();
  const file = body.file as File | undefined;
  const title = String(body.title ?? '').trim();

  if (!title) return c.json({ error: '请填写小说名' }, 400);
  if (!file || !file.name.endsWith('.txt')) return c.json({ error: '仅支持 txt 文件' }, 400);
  // 20MB ≈ 700 万字 ≈ 1.7 万块，异步入库 + 429 重试可覆盖；上限主要防滥用而非技术瓶颈
  if (file.size > 20 * 1024 * 1024) return c.json({ error: '文件不能超过 20MB' }, 400);

  const raw = await file.text();
  const chunks = chunkNovel(raw);
  if (chunks.length === 0) return c.json({ error: '未解析到有效内容（需包含"第X章"等章节标题）' }, 400);

  // 异步入库：立即返回 jobId，前端轮询进度（长篇向量化要几分钟，不能同步挂着）
  const jobId = startIngestJob(title, raw);
  return c.json({ jobId }, 202);
});

/** 入库任务进度查询 */
app.get('/api/novels/jobs/:id', (c: Context) => {
  const job = getJob(c.req.param('id') as string);
  if (!job) return c.json({ error: '任务不存在' }, 404);
  return c.json(job);
});

app.delete('/api/novels/:id', (c: Context) => {
  if (!c.get('isAdmin')) return c.json({ error: '需要管理员权限', needLogin: true }, 401);
  return c.json({ ok: deleteNovel(c.req.param('id') as string) });
});

// 静态托管前端构建产物（必须放在 API 路由之后）
app.use('*', serveStatic({ root: './frontend/dist' }));
// SPA 兜底：非 API 路径回退到 index.html
app.get('*', serveStatic({ path: './frontend/dist/index.html' }));

const port = Number(process.env.PORT) || 3001;
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`✅ 问问 Agent 服务已启动: http://localhost:${info.port}`);
});
