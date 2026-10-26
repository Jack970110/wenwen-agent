<script setup lang="ts">
import { computed } from 'vue';
import MarkdownIt from 'markdown-it';

const md = new MarkdownIt({ breaks: true });

const props = defineProps<{
  role: 'user' | 'assistant';
  text: string;
  streaming?: boolean;
}>();

// 必须用 computed：props.text 流式更新时重新渲染 Markdown。
// 之前写成普通常量导致响应式断裂——首次渲染算一次就不再更新，页面"无反应"
const rendered = computed(() => (props.role === 'assistant' ? md.render(props.text) : ''));
</script>

<template>
  <div class="msg" :class="role">
    <div class="avatar">{{ role === 'user' ? '我' : '问' }}</div>
    <div class="bubble">
      <!-- 用户消息纯文本；助手消息走 Markdown 渲染 -->
      <div v-if="role === 'user'" class="content plain">{{ text }}</div>
      <div v-else-if="streaming && !text" class="content thinking">思考中<span class="dots"><i>·</i><i>·</i><i>·</i></span></div>
      <div v-else class="content md" :class="{ streaming }" v-html="rendered"></div>
    </div>
  </div>
</template>

<style scoped>
.msg { max-width: 780px; margin: 0 auto 18px; display: flex; gap: 10px; }
.avatar {
  width: 30px; height: 30px; border-radius: 8px; flex-shrink: 0; margin-top: 2px;
  display: flex; align-items: center; justify-content: center; font-size: 13px;
}
.msg.user .avatar { background: var(--panel2); }
.msg.assistant .avatar { background: linear-gradient(135deg, var(--accent), var(--accent2)); }
.content {
  background: var(--panel); border: 1px solid var(--border); border-radius: 10px;
  padding: 12px 16px; line-height: 1.75; word-break: break-word;
}
.content.plain { color: var(--dim); background: transparent; border: none; padding: 5px 0; }
.content.md :deep(p) { margin: 0 0 8px; }
.content.md :deep(p:last-child) { margin-bottom: 0; }
.content.md :deep(pre) {
  background: var(--bg); padding: 10px 12px; border-radius: 8px; overflow-x: auto;
  font-size: 13px; margin: 8px 0;
}
.content.md :deep(code) { font-family: ui-monospace, monospace; font-size: 13px; }
.content.md :deep(table) { border-collapse: collapse; margin: 8px 0; width: 100%; }
.content.md :deep(th), .content.md :deep(td) { border: 1px solid var(--border); padding: 5px 10px; font-size: 13px; }
.content.md.streaming::after { content: '▍'; color: var(--accent); animation: blink 1s infinite; }
.content.thinking { color: var(--dim); font-style: normal; }
.content.thinking .dots i {
  animation: blink 1.2s infinite; font-style: normal; color: var(--accent);
}
.content.thinking .dots i:nth-child(2) { animation-delay: .2s; }
.content.thinking .dots i:nth-child(3) { animation-delay: .4s; }
@keyframes blink { 50% { opacity: 0; } }
</style>
