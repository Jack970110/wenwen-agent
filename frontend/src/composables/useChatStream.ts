import { ref, type Ref } from 'vue';
import type { ChatEvent } from '../types';

/**
 * 统一 AI 交互层（Composable 模式）：
 * 把「发送 → SSE 解析 → 事件分发 → 状态管理 → 中断控制」收敛为单一逻辑层，
 * 组件只消费状态，不关心流协议——妙笔多模型交互层架构的个人项目复刻。
 *
 * SSE 手动解析的原因：EventSource 只支持 GET，带 body 的 POST 推流
 * 必须用 fetch + ReadableStream 手动处理分包边界（buf 残留不完整行）。
 */
export function useChatStream(sessionId: Ref<string>) {
  const messages = ref<{ id: string; role: 'user' | 'assistant'; text: string }[]>([]);
  const toolCalls = ref<{ name: string; args: string; error?: boolean }[]>([]);
  const streaming = ref(false);
  const errorMsg = ref('');
  let abortCtrl: AbortController | null = null;

  async function send(text: string, onDone?: () => void) {
    if (streaming.value || !text.trim()) return;
    streaming.value = true;
    errorMsg.value = '';
    messages.value.push({ id: crypto.randomUUID(), role: 'user', text });
    // 占位的 assistant 消息，流式内容追加到它身上
    const assistant = { id: crypto.randomUUID(), role: 'assistant' as const, text: '' };
    messages.value.push(assistant);
    toolCalls.value = [];

    abortCtrl = new AbortController();
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: sessionId.value, message: text }),
        signal: abortCtrl.signal,
      });
      if (!res.ok || !res.body) {
        const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error((err as any).error || `HTTP ${res.status}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';

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
            assistant.text += evt.text!;
          } else if (evt.type === 'tool-call') {
            toolCalls.value.push({ name: evt.toolName!, args: JSON.stringify(evt.args) });
          } else if (evt.type === 'tool-error') {
            toolCalls.value.push({ name: evt.toolName!, args: String(evt.args), error: true });
          } else if (evt.type === 'error') {
            errorMsg.value = evt.message!;
          }
        }
      }
      onDone?.();
    } catch (e: any) {
      if (e.name !== 'AbortError') errorMsg.value = e.message || '连接中断';
    } finally {
      streaming.value = false;
      abortCtrl = null;
    }
  }

  /** 用户点停止 → 中断连接 → 服务端感知断连，取消上游模型请求 */
  function stop() {
    abortCtrl?.abort();
  }

  return { messages, toolCalls, streaming, errorMsg, send, stop };
}
