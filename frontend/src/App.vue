<script setup lang="ts">
import { ref, watch } from 'vue';
import { useSessionStore } from './stores/sessions';
import { useChatStream } from './composables/useChatStream';
import Sidebar from './components/Sidebar.vue';
import MessageBubble from './components/MessageBubble.vue';
import ToolLine from './components/ToolLine.vue';
import ChatInput from './components/ChatInput.vue';

const store = useSessionStore();
const sessionId = ref('');

// sessionId 变化 = 切换会话，重建交互层（妙笔模式：会话隔离在交互层之上）
const chat = useChatStream(sessionId);

const QUICK_QUESTIONS = [
  '看看第 1 到 8 章的数据，读者流失发生在哪里？',
  '钥匙藏在哪里？',
  '帮我整体分析这本书的数据表现，出一份报告',
];

function onSelect(id: string) {
  sessionId.value = id;
  loadHistory();
}

async function loadHistory() {
  const msgs = await (await fetch(`/api/sessions/${sessionId.value}/messages`)).json();
  chat.messages.value = msgs.map((m: any) => ({
    id: m.id,
    role: m.role,
    text: m.parts.filter((p: any) => p.type === 'text').map((p: any) => p.text).join(''),
  }));
  chat.toolCalls.value = [];
  chat.errorMsg.value = '';
}

// 初始化
store.refresh().then(async () => {
  if (!store.currentId) await store.create();
  sessionId.value = store.currentId;
});
watch(() => store.currentId, (id) => {
  // store.create()/open() 更新 currentId 后同步交互层（首次初始化跳过，上面已处理）
  if (id && id !== sessionId.value) {
    sessionId.value = id;
    loadHistory();
  }
});

const inputRef = ref<InstanceType<typeof ChatInput>>();
</script>

<template>
  <div class="app">
    <Sidebar @select="onSelect" />
    <main>
      <header>
        <div class="page-title">{{ store.list.find(s => s.id === sessionId)?.title || '新对话' }}</div>
        <div class="model">glm-4-flash · RAG · MCP</div>
      </header>

      <div class="chat-area">
        <template v-if="chat.messages.value.length">
          <template v-for="(m, i) in chat.messages.value" :key="m.id">
            <!-- 助手消息前插入它对应的工具调用时间线 -->
            <template v-if="m.role === 'assistant'">
              <ToolLine
                v-for="(t, j) in chat.toolCalls.value"
                :key="'t' + j"
                :name="t.name"
                :args="t.args"
                :error="t.error"
              />
            </template>
            <MessageBubble :role="m.role" :text="m.text" :streaming="chat.streaming.value && i === chat.messages.value.length - 1" />
          </template>
          <div v-if="chat.errorMsg.value" class="error-banner">❌ {{ chat.errorMsg.value }}</div>
        </template>

        <div v-else class="empty-state">
          <div class="big">问问 Agent</div>
          <div class="desc">小说语义问答（RAG）· 阅读数据分析 · 报告生成</div>
          <div class="quick">
            <button v-for="q in QUICK_QUESTIONS" :key="q" @click="chat.send(q)">{{ q }}</button>
          </div>
        </div>
      </div>

      <ChatInput
        ref="inputRef"
        :disabled="chat.streaming.value"
        @send="chat.send($event, () => store.refresh())"
        @stop="chat.stop()"
      />
    </main>
  </div>
</template>

<style scoped>
.app { display: flex; height: 100vh; }
main { flex: 1; display: flex; flex-direction: column; min-width: 0; }
header {
  padding: 12px 20px; border-bottom: 1px solid var(--border);
  display: flex; align-items: center; justify-content: space-between;
}
.page-title { font-weight: 600; font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.model { font-size: 12px; color: var(--dim); background: var(--panel2); padding: 3px 10px; border-radius: 99px; flex-shrink: 0; margin-left: 12px; }
.chat-area { flex: 1; overflow-y: auto; padding: 20px; }
.error-banner {
  max-width: 780px; margin: 0 auto 16px; padding: 10px 14px;
  background: rgba(248,113,113,.1); border: 1px solid var(--err); border-radius: 8px;
  color: var(--err); font-size: 13px;
}
.empty-state { text-align: center; margin-top: 16vh; }
.big { font-size: 26px; font-weight: 700; background: linear-gradient(135deg, var(--accent), var(--accent2)); -webkit-background-clip: text; background-clip: text; color: transparent; }
.desc { color: var(--dim); margin: 8px 0 24px; font-size: 13px; }
.quick { display: flex; flex-direction: column; gap: 8px; align-items: center; }
.quick button {
  background: var(--panel); border: 1px solid var(--border); color: var(--text);
  padding: 9px 18px; border-radius: 9px; cursor: pointer; font-size: 13px; transition: border-color .15s;
}
.quick button:hover { border-color: var(--accent); }
</style>
