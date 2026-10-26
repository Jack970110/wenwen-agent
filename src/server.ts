import 'dotenv/config';
import { serve } from '@hono/node-server';
import { Hono, type Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import { serveStatic } from '@hono/node-server/serve-static';
import { convertToModelMessages, type UIMessage } from 'ai';
import { runAgent } from './agent.js';
import { appendMessage, createSession, deleteSession, getMessages, listSessions, sessionExists } from './db.js';
import { chunkNovel } from './rag/chunker.js';
import { listNovels, deleteNovel } from './rag/store.js';
import { getJob, startIngestJob } from './rag/ingestJob.js';

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

app.post('/api/chat', async (c: Context) => {
  const { sessionId, message } = (await c.req.json()) as {
    sessionId: string;
    message: string;
  };
  if (!sessionId || !message?.trim()) {
    return c.json({ error: 'sessionId 和 message 必填' }, 400);
  }
  if (!sessionExists(sessionId)) {
    return c.json({ error: '会话不存在' }, 404);
  }

  const userMsg: UIMessage = {
    id: crypto.randomUUID(),
    role: 'user',
    parts: [{ type: 'text', text: message.trim() }],
  };
  appendMessage(sessionId, userMsg);
  const rawHistory = getMessages(sessionId);

  // 历史卫生：正常序列必须 user/assistant 交替。
  // 回答被停止或失败时会留下"悬空提问"（连续两条 user），小模型会被带偏。
  // 策略：只保留最后一条悬空提问（即本轮），丢弃更早的。
  const history: UIMessage[] = [];
  for (const m of rawHistory) {
    if (m.role === 'user' && history[history.length - 1]?.role === 'user') {
      history.pop();
    }
    history.push(m);
  }
  // 防御：任何情况下发给模型的消息都不能为空
  if (history.length === 0) history.push(userMsg);

  // 客户端断开（关页面/点停止）→ abortController 触发 → streamText 取消上游请求
  // 不取消的话模型会继续生成，token 照烧
  const abortController = new AbortController();
  c.req.raw.signal.addEventListener('abort', () => abortController.abort());

  return streamSSE(c, async (stream) => {
    let assistantText = '';
    let errored = false;
    try {
      const result = runAgent(await convertToModelMessages(history), abortController.signal);

      for await (const part of result.fullStream) {
        if (part.type === 'tool-call') {
          await stream.writeSSE({
            data: JSON.stringify({ type: 'tool-call', toolName: part.toolName, args: part.input }),
          });
        } else if (part.type === 'tool-error') {
          await stream.writeSSE({
            data: JSON.stringify({ type: 'tool-error', toolName: part.toolName, error: String(part.error) }),
          });
        } else if (part.type === 'text-delta') {
          assistantText += part.text;
          await stream.writeSSE({ data: JSON.stringify({ type: 'text-delta', text: part.text }) });
        }
      }

      appendMessage(sessionId, {
        id: crypto.randomUUID(),
        role: 'assistant',
        parts: [{ type: 'text', text: assistantText }],
      });
      await stream.writeSSE({ data: JSON.stringify({ type: 'done' }) });
    } catch (err) {
      // 客户端主动断开不算错误，静默结束即可
      if (abortController.signal.aborted) {
        // 即使没有生成任何文字也要落库占位，否则历史里会留下悬空提问污染后续对话
        appendMessage(sessionId, {
          id: crypto.randomUUID(),
          role: 'assistant',
          parts: [{ type: 'text', text: (assistantText || '（已停止生成）') + '' }],
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
      appendMessage(sessionId, {
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

app.get('/api/sessions', (c: Context) => c.json(listSessions()));

app.get('/api/sessions/:id/messages', (c: Context) =>
  c.json(getMessages(c.req.param('id') as string)),
);

app.post('/api/sessions', (c: Context) => c.json({ sessionId: createSession() }));

app.delete('/api/sessions/:id', (c: Context) =>
  c.json({ ok: deleteSession(c.req.param('id') as string) }),
);

/** 小说库：列表 / 上传入库 / 删除 */
app.get('/api/novels', (c: Context) => c.json(listNovels()));

app.post('/api/novels', async (c: Context) => {
  const body = await c.req.parseBody();
  const file = body.file as File | undefined;
  const title = String(body.title ?? '').trim();

  if (!title) return c.json({ error: '请填写小说名' }, 400);
  if (!file || !file.name.endsWith('.txt')) return c.json({ error: '仅支持 txt 文件' }, 400);
  if (file.size > 5 * 1024 * 1024) return c.json({ error: '文件不能超过 5MB' }, 400);

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

app.delete('/api/novels/:id', (c: Context) =>
  c.json({ ok: deleteNovel(c.req.param('id') as string) }),
);

// 静态托管前端构建产物（必须放在 API 路由之后）
app.use('*', serveStatic({ root: './frontend/dist' }));
// SPA 兜底：非 API 路径回退到 index.html
app.get('*', serveStatic({ path: './frontend/dist/index.html' }));

const port = Number(process.env.PORT) || 3001;
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`✅ 问问 Agent 服务已启动: http://localhost:${info.port}`);
});
