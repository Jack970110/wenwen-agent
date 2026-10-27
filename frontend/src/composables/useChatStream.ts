import { reactive, ref, type Ref } from 'vue';
import type { ChatEvent } from '../types';
import { uuid } from '../utils/uuid';

/**
 * 统一 AI 交互层（Composable 模式）：
 * 把「发送 → SSE 解析 → 事件分发 → 状态管理 → 中断控制」收敛为单一逻辑层，
 * 组件只消费状态，不关心流协议——妙笔多模型交互层架构的个人项目复刻。
 *
 * SSE 手动解析的原因：EventSource 只支持 GET，带 body 的 POST 推流
 * 必须用 fetch + ReadableStream 手动处理分包边界（buf 残留不完整行）。
 */
export interface ToolCall {
  name: string;
  args: string;
  error?: boolean;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  /** 该条消息对应的工具调用（仅本条消息的，不共享） */
  tools: ToolCall[];
  /** 深度思考模式下的思维链（可折叠展示） */
  reasoning: string;
  /** 来自历史加载的消息：思考过程默认收起（本次会话内生成的默认展开） */
  fromHistory?: boolean;
}

export function useChatStream(sessionId: Ref<string>) {
  const messages = ref<ChatMessage[]>([]);
  const streaming = ref(false);
  const errorMsg = ref('');
  /** 当前阶段状态（检索资料中/深度思考中…），流结束清空 */
  const status = ref('');
  let abortCtrl: AbortController | null = null;

  async function send(text: string, opts: { novelTitle?: string; deep?: boolean } = {}, onDone?: () => void) {
    if (streaming.value || !text.trim()) return;
    streaming.value = true;
    errorMsg.value = '';
    messages.value.push({ id: uuid(), role: 'user', text, tools: [], reasoning: '' });
    // 占位的 assistant 消息，流式内容与工具调用都挂它自己身上
    // 必须用 reactive()：push 进 ref 数组后直接改原始对象不触发响应式（拿到的是 raw 而非 proxy），
    // 流式内容会攒到 streaming=false 的那次重渲染才一次性出现
    const assistant = reactive<ChatMessage>({ id: uuid(), role: 'assistant', text: '', tools: [], reasoning: '' });
    messages.value.push(assistant);

    abortCtrl = new AbortController();
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: sessionId.value,
          message: text,
          novelTitle: opts.novelTitle || undefined,
          deep: opts.deep || undefined,
        }),
        signal: abortCtrl.signal,
      });
      if (res.status === 401) { location.href = '/login'; return; }
      if (!res.ok || !res.body) {
        const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error((err as any).error || `HTTP ${res.status}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      // 诊断：观察 delta 在浏览器端的到达节奏（控制台每 50 条打一条）
      const streamStart = performance.now();
      let firstDeltaAt = 0;
      let deltaCount = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop()!; // 不完整的行留到下一轮

        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          const evt: ChatEvent = JSON.parse(line.slice(5));
          if (evt.type === 'text-delta') {
            if (!firstDeltaAt) { firstDeltaAt = performance.now(); console.log(`[stream] 首个 text-delta 到达于请求后 ${(firstDeltaAt - streamStart).toFixed(0)}ms`); }
            deltaCount++;
            if (deltaCount % 50 === 0) console.log(`[stream] 已收到 ${deltaCount} 个 delta @ ${(performance.now() - streamStart).toFixed(0)}ms`);
            assistant.text += evt.text!;
          } else if (evt.type === 'reasoning-delta') {
            if (!firstDeltaAt) { firstDeltaAt = performance.now(); console.log(`[stream] 首个 reasoning-delta 到达于请求后 ${(firstDeltaAt - streamStart).toFixed(0)}ms`); }
            deltaCount++;
            if (deltaCount % 50 === 0) console.log(`[stream] 已收到 ${deltaCount} 个 delta @ ${(performance.now() - streamStart).toFixed(0)}ms`);
            assistant.reasoning += evt.text!;
          } else if (evt.type === 'status') {
            status.value = evt.message!;
          } else if (evt.type === 'tool-call') {
            assistant.tools.push({ name: evt.toolName!, args: JSON.stringify(evt.args) });
          } else if (evt.type === 'tool-error') {
            assistant.tools.push({ name: evt.toolName!, args: String(evt.args), error: true });
          } else if (evt.type === 'error') {
            errorMsg.value = evt.message!;
          }
        }
      }
      onDone?.();
      if (deltaCount) console.log(`[stream] 结束：共 ${deltaCount} 个 delta，总耗时 ${(performance.now() - streamStart).toFixed(0)}ms（若逐条到达，上面应每隔 ~300ms 打一条）`);
    } catch (e: any) {
      if (e.name !== 'AbortError') errorMsg.value = e.message || '连接中断';
    } finally {
      streaming.value = false;
      status.value = '';
      abortCtrl = null;
    }
  }

  /** 用户点停止 → 中断连接 → 服务端感知断连，取消上游模型请求 */
  function stop() {
    abortCtrl?.abort();
  }

  return { messages, streaming, status, errorMsg, send, stop };
}
