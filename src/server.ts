import 'dotenv/config';
import { serve } from '@hono/node-server';
import { Hono, type Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import { setCookie, getCookie } from 'hono/cookie';
import { serveStatic } from '@hono/node-server/serve-static';
import { type ModelMessage, streamText } from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { runAgent, type FocusInfo } from './agent.js';
import { appendMessage, checkChatLimits, claimGuestSessions, cleanupStaleGuestSessions, createSession, deleteSession, getMessages, getSessionFocus, getSessionMeta, listSessions, sessionExists, setSessionFocus, type StoredMessage } from './db.js';
import { chunkNovel } from './rag/chunker.js';
import { listNovels, deleteNovel, getNovelByTitle, getNovelMeta, getNovelFullText, getNovelBookSummary, backfillAllMissingMeta } from './rag/store.js';
import { getJob, startIngestJob } from './rag/ingestJob.js';
import { contentHash, deleteStaleIngestNovels, findNovelByContentHash } from './rag/store.js';
import { determineTier } from './rag/tier.js';
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

/** 身份解析：admin = 有效密码 cookie（返回用户名）；guest = 匿名 visitorId cookie（首次访问自动种） */
app.use('*', async (c: Context, next) => {
  let visitorId = getCookie(c, 'visitor');
  if (!visitorId) {
    visitorId = crypto.randomUUID();
    setCookie(c, 'visitor', visitorId, { path: '/', maxAge: 60 * 60 * 24 * 365, sameSite: 'Lax', httpOnly: true });
  }
  c.set('visitorId', visitorId);
  const adminUser = verifyToken(getCookie(c, 'auth'));
  c.set('isAdmin', !!adminUser);
  c.set('adminUser', adminUser ?? '');
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

app.post('/api/login', async (c: Context) => {
  const { username, password } = (await c.req.json()) as { username?: string; password?: string };
  const trimmed = username?.trim() ?? '';
  if (!trimmed || !checkPassword(trimmed, password ?? '')) {
    return c.json({ error: '用户名或密码错误' }, 401);
  }
  setCookie(c, 'auth', makeToken(trimmed), {
    httpOnly: true, sameSite: 'Lax', path: '/', maxAge: 60 * 60 * 24 * 30, // 30 天
  });
  // 登录收编（claim）：游客匿名身份下的会话迁移到该账号名下，体验数据无缝继承
  const claimed = claimGuestSessions(c.get('visitorId') as string, trimmed);
  if (claimed > 0) console.log(`[auth] ${trimmed} 登录，收编游客会话 ${claimed} 条`);
  return c.json({ ok: true, username: trimmed });
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
  // 会话按身份隔离：游客用 visitorId，管理员用自己的用户名
  const visitorId = c.get('visitorId') as string;
  const owner = c.get('adminUser') || visitorId;
  if (!sessionExists(sessionId, owner)) {
    return c.json({ error: '会话不存在' }, 404);
  }
  // 聚焦小说：请求参数优先（兼容旧客户端），否则读会话上绑定的值
  // 游客只能聚焦公开演示库；绑定书不存在时退化为全库检索
  const focus = resolveFocus(c, novelTitle, sessionId, owner);
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

      await ragScope.run({ onlyPublic, tier: focus?.tier, fullText: focus?.fullText }, async () => {
        if (deep) {
        /**
         * 两阶段深度模式（绕过智谱 Z1 流式工具调用的接口缺陷）：
         * 阶段 1：快模型跑 Agent loop 完成工具调用/检索（此链路稳定），收集检索结果
         * 阶段 2：Z1 不带工具，基于资料做纯推理合成——"廉价模型检索、强模型合成"
         * 例外：聚焦书为 T1 时全文已可注入，跳过阶段 1 直接 Z1 推理
         */
        let z1Messages: ModelMessage[] = modelInput as ModelMessage[];
        let z1System = '你是深度分析助手。基于提供的检索资料深度思考后回答用户最后的问题。要求：提炼归纳、标注书名和章节出处、资料里没有的内容不编造、资料不足时如实说明。';

        if (focus?.tier === 'T1' && focus.fullText) {
          // T1 微型书：全文直接注入，跳过检索阶段
          await sendEvent({ type: 'status', message: '深度思考中…' });
          z1Messages = [
            ...modelInput,
            { role: 'assistant', content: `[已提供资料]\n《${focus.title}》全文：\n${focus.fullText}` },
            { role: 'user', content: '请基于以上文档全文，深度思考后回答我之前的问题。要求提炼归纳、标注章节或段落出处。' },
          ];
        } else {
          await sendEvent({ type: 'status', message: '检索资料中…' });
          const fast = runAgent(modelInput as ModelMessage[], abortController.signal, { retrievalOnly: true, focus });
          const toolResults: { name: string; output: string }[] = [];
          for await (const part of fast.fullStream) {
            if (part.type === 'tool-call') {
              toolEvents.push({ name: part.toolName, args: JSON.stringify(part.input) });
              await sendEvent({ type: 'tool-call', toolName: part.toolName, args: part.input });
            } else if (part.type === 'tool-error') {
              // 工具失败必须落日志：以前静默只推前端，线上排查无门
              console.error(`[tool-error] ${part.toolName}: ${String(part.error).slice(0, 300)}`);
              toolEvents.push({ name: part.toolName, args: JSON.stringify(part.input ?? ''), error: true });
              await sendEvent({ type: 'tool-error', toolName: part.toolName, error: String(part.error) });
            } else if (part.type === 'tool-result') {
              toolResults.push({ name: part.toolName, output: JSON.stringify(part.output).slice(0, 6000) });
            }
          }

          await sendEvent({ type: 'status', message: '深度思考中…' });
          const context = toolResults.length
            ? toolResults.map((r) => `[${r.name} 检索结果]\n${r.output}`).join('\n\n')
            : '（本轮没有检索到资料，若问题涉及知识库内容请如实说明未找到）';
          z1Messages = [
            ...modelInput,
            { role: 'assistant', content: `[已完成的检索资料]\n${context}` },
            { role: 'user', content: '请基于以上检索资料，深度思考后回答我之前的问题。' },
          ];
        }

        // 阶段 2：Z1 纯推理合成（T1 与两阶段共用此流式输出）
        const deepStart = Date.now();
        let firstDeltaAt = 0;
        let deltaCount = 0;
        const deepResult = streamText({
          model: zhipuDeep(process.env.MODEL_DEEP || 'glm-z1-flash'),
          system: z1System,
          messages: z1Messages,
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
        const result = runAgent(modelInput as ModelMessage[], abortController.signal, { focus });

        for await (const part of result.fullStream) {
          if (part.type === 'tool-call') {
            toolEvents.push({ name: part.toolName, args: JSON.stringify(part.input) });
            await sendEvent({ type: 'tool-call', toolName: part.toolName, args: part.input });
          } else if (part.type === 'tool-error') {
            // 工具失败必须落日志：以前静默只推前端，线上排查无门
            console.error(`[tool-error] ${part.toolName}: ${String(part.error).slice(0, 300)}`);
            toolEvents.push({ name: part.toolName, args: JSON.stringify(part.input ?? ''), error: true });
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
  const owner = c.get('adminUser') || (c.get('visitorId') as string);
  return c.json(listSessions(owner));
});

app.get('/api/sessions/:id/messages', (c: Context) => {
  const owner = c.get('adminUser') || (c.get('visitorId') as string);
  return c.json(getMessages(c.req.param('id') as string, owner));
});

app.post('/api/sessions', (c: Context) => {
  const owner = c.get('adminUser') || (c.get('visitorId') as string);
  return c.json({ sessionId: createSession(owner) });
});

app.delete('/api/sessions/:id', (c: Context) => {
  const owner = c.get('adminUser') || (c.get('visitorId') as string);
  return c.json({ ok: deleteSession(c.req.param('id') as string, owner) });
});

/** 会话元信息（含聚焦小说），前端选择器状态恢复用 */
app.get('/api/sessions/:id', (c: Context) => {
  const owner = c.get('adminUser') || (c.get('visitorId') as string);
  const meta = getSessionMeta(c.req.param('id') as string, owner);
  if (!meta) return c.json({ error: '会话不存在' }, 404);
  return c.json(meta);
});

/** 设置会话聚焦小说（null = 全库检索）。游客只能绑定公开演示库 */
app.patch('/api/sessions/:id/focus', async (c: Context) => {
  const owner = c.get('adminUser') || (c.get('visitorId') as string);
  const sessionId = c.req.param('id') as string;
  const { novelTitle } = (await c.req.json()) as { novelTitle?: string | null };
  const title = novelTitle?.trim() || null;
  if (title) {
    const novel = getNovelByTitle(title);
    const publicOk = !c.get('isAdmin') ? novel?.owner === 'public' : !!novel;
    if (!publicOk) return c.json({ error: '知识库中没有该文档' }, 400);
  }
  if (!setSessionFocus(sessionId, owner, title)) return c.json({ error: '会话不存在' }, 404);
  return c.json({ ok: true, focusNovel: title });
});

/** 聚焦小说解析：请求参数优先，其次会话绑定值；游客仅限公开库，失效则退化为全库。
 *  返回 FocusInfo（含体量级别与 T1 全文），供提示词注入与深度模式分支使用 */
function resolveFocus(c: Context, paramTitle: string | undefined, sessionId: string, owner: string): FocusInfo | undefined {
  const candidates = [paramTitle, getSessionFocus(sessionId, owner)].filter(Boolean) as string[];
  for (const title of candidates) {
    const novel = getNovelByTitle(title);
    if (novel && (c.get('isAdmin') || novel.owner === 'public')) {
      const meta = getNovelMeta(novel.id);
      // 兜底：分级功能上线前入库的书 meta 里没有 tier——按字数重算而不是猜 T2，
      // 否则百万字体量的存量书永远走不到 T4 的查询分解/多路检索
      const tier = meta?.tier ?? determineTier(meta?.totalChars ?? 0);
      return {
        title: novel.title,
        tier,
        fullText: tier === 'T1' ? getNovelFullText(novel.id) : null,
        bookSummary: getNovelBookSummary(novel.id) ?? undefined,
      };
    }
  }
  return undefined;
}

/** 小说库：游客读公开演示库；上传/删除是管理员操作 */
app.get('/api/novels', (c: Context) => c.json(listNovels(c.get('adminUser') ? 'admin' : 'guest')));

app.post('/api/novels', async (c: Context) => {
  if (!c.get('isAdmin')) return c.json({ error: '需要管理员权限', needLogin: true }, 401);
  const body = await c.req.parseBody();
  const file = body.file as File | undefined;
  const title = String(body.title ?? '').trim();

  if (!title) return c.json({ error: '请填写文档名' }, 400);
  if (!file || !file.name.endsWith('.txt')) return c.json({ error: '仅支持 txt 文件' }, 400);
  // 20MB ≈ 700 万字 ≈ 1.7 万块，异步入库 + 429 重试可覆盖；上限主要防滥用而非技术瓶颈
  if (file.size > 20 * 1024 * 1024) return c.json({ error: '文件不能超过 20MB' }, 400);

  const raw = await file.text();
  // 指纹查重：同内容文件直接 409，不占用并发名额、不跑切块
  const dup = findNovelByContentHash(contentHash(raw));
  if (dup) return c.json({ error: `该文件内容已入库（《${dup.title}》），无需重复上传` }, 409);
  // 可选切块参数（表单字段，不传走默认）：chunkSize / chunkMin / chunkOverlap
  const num = (v: unknown) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };
  const chunkOpts = {
    targetSize: num(body.chunkSize),
    minSize: num(body.chunkMin),
    overlap: num(body.chunkOverlap),
  };
  const chunks = chunkNovel(raw, chunkOpts);
  if (chunks.length === 0) return c.json({ error: '未解析到有效内容（需包含"第X章"等章节标题）' }, 400);

  // 异步入库：立即返回 jobId，前端轮询进度（长篇向量化要几分钟，不能同步挂着）
  try {
    const jobId = startIngestJob(title, raw, chunkOpts);
    return c.json({ jobId }, 202);
  } catch (e) {
    // 并发上限（默认 1 个）：让前端明确失败，而不是排队后进度互相覆盖
    return c.json({ error: e instanceof Error ? e.message : '入库任务启动失败' }, 429);
  }
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
  console.log(`✅ 问渠 Agent 服务已启动: http://localhost:${info.port}`);
  // TTL 成本治理：清理 7 天无活动的游客会话（管理员账号名下的不受影响）
  const removed = cleanupStaleGuestSessions(7, [...getAdminUsers().keys(), 'admin']);
  if (removed > 0) console.log(`[cleanup] 已清理 ${removed} 条过期游客会话`);
  // 自愈：老版本入库的小说缺失结构元数据，从已有块回填（无需重新向量化）
  const backfilled = backfillAllMissingMeta();
  if (backfilled > 0) console.log(`[meta] 已回填 ${backfilled} 本小说的结构元数据`);
  // 自愈：进程重启会丢掉内存里的入库任务，卡在 ingesting 的是半截数据，启动时清掉
  const stale = deleteStaleIngestNovels();
  if (stale > 0) console.log(`[cleanup] 已清理 ${stale} 条中断的入库任务（可重新上传）`);
});
