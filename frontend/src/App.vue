<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue';
import { useSessionStore } from './stores/sessions';
import { useChatStream } from './composables/useChatStream';
import Sidebar from './components/Sidebar.vue';
import MessageBubble from './components/MessageBubble.vue';
import ToolLine from './components/ToolLine.vue';
import ChatInput from './components/ChatInput.vue';
import { useNovelStore } from './stores/novels';
import { fetchMe } from './stores/me';
import LoginView from './views/LoginView.vue';

const store = useSessionStore();
const novelStore = useNovelStore();
const sessionId = ref('');
/** 会话级聚焦小说：绑定在会话上（存库），切回来自动恢复；空 = 全库检索 */
const focusNovel = ref('');

/** 选择器变更 → 持久化到会话 */
function onFocusChange() {
  if (sessionId.value) store.setFocus(sessionId.value, focusNovel.value || null);
}

/** 从会话元信息恢复聚焦状态 */
async function restoreFocus(id: string) {
  const res = await fetch(`/api/sessions/${id}`);
  if (res.ok) {
    const meta = await res.json();
    focusNovel.value = meta.focusNovel || '';
  }
}
/** 深度思考三态：auto=启发式自动路由（默认）/ deep=强制深度 / fast=强制快速 */
const deepMode = ref<'auto' | 'deep' | 'fast'>('auto');

/** 启发式判断：多步因果/分析类问题走深度模型，短事实问句走快速模型 */
function looksComplex(q: string): boolean {
  return q.length > 40 || /为什么|分析|对比|总结|原因|区别|评价|隐喻|象征|怎么看|怎么办|解读|含义|哪个更/.test(q);
}

function resolveDeep(text: string): boolean {
  if (deepMode.value === 'deep') return true;
  if (deepMode.value === 'fast') return false;
  return looksComplex(text);
}

// sessionId 变化 = 切换会话，重建交互层（妙笔模式：会话隔离在交互层之上）
const chat = useChatStream(sessionId);

const QUICK_QUESTIONS = [
  '看看第 1 到 8 章的数据，读者流失发生在哪里？',
  '钥匙藏在哪里？',
  '帮我整体分析这本书的数据表现，出一份报告',
  '库里有哪些文档？分别讲了什么？',
];

function onSelect(id: string) {
  sessionId.value = id;
  loadHistory();
  restoreFocus(id);
}

async function loadHistory() {
  const msgs = await (await fetch(`/api/sessions/${sessionId.value}/messages`)).json();
  chat.messages.value = msgs.map((m: any) => ({
    id: m.id,
    role: m.role,
    text: m.parts.filter((p: any) => p.type === 'text').map((p: any) => p.text).join(''),
    // 从持久化的 tool part 还原时间线
    tools: m.parts.filter((p: any) => p.type === 'tool').map((p: any) => ({ name: p.name, args: p.args, error: p.error })),
    reasoning: '',
    fromHistory: true,
  }));
}

// 初始化：优先恢复最近一条对话（Pinia 状态不持久化，刷新会丢 currentId；
// 无脑 create 会导致每次刷新都多一条空对话），没有任何对话才新建
store.refresh().then(async () => {
  if (store.list.length) {
    await store.open(store.list[0].id); // 列表按时间倒序，[0] 是最近的
  } else {
    await store.create();
  }
  sessionId.value = store.currentId;
});
novelStore.resume();
fetchMe(); // 游客/管理员身份，决定管理按钮显隐
watch(() => store.currentId, (id) => {
  // store.create()/open() 更新 currentId 后同步交互层（首次初始化跳过，上面已处理）
  if (id && id !== sessionId.value) {
    sessionId.value = id;
    loadHistory();
    restoreFocus(id);
  }
});

const inputRef = ref<InstanceType<typeof ChatInput>>();
/** 最后一条消息的 id：本次会话内生成的思考过程默认展开 */
const lastMsgId = computed(() => {
  const list = chat.messages.value;
  return list.length ? list[list.length - 1].id : '';
});

/** 流式输出自动滚动：内容或状态变化时跟随到底部；用户上翻历史时不打扰 */
/** 登录视图：/login 路径时渲染（登录成功后整页跳回 /，管理员身份由 fetchMe 拉取） */
const isLoginRoute = ref(location.pathname === '/login');
function onLoginSuccess() {
  location.replace('/'); // 整页跳转最简单可靠：登录后以管理员身份重新初始化全部状态
}

const chatArea = ref<HTMLElement>();
async function followBottom() {
  const el = chatArea.value;
  if (!el) return;
  // 距底部 120px 以内视为"正在阅读最新内容"，否则用户在翻历史，不滚动
  const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  if (!nearBottom) return;
  await nextTick(); // 等 DOM 渲染完新内容再滚
  el.scrollTop = el.scrollHeight;
}
watch(() => chat.messages.value, () => followBottom(), { deep: true });
watch(() => chat.status.value, () => followBottom());
watch(sessionId, () => nextTick(() => { if (chatArea.value) chatArea.value.scrollTop = chatArea.value.scrollHeight; }));
</script>

<template>
  <!-- /login：管理员登录视图（游客可直达应用，无需登录） -->
  <LoginView v-if="isLoginRoute" @success="onLoginSuccess" />

  <div v-else class="app">
    <Sidebar @select="onSelect" />
    <main>
      <header>
        <div class="page-title">{{ store.list.find(s => s.id === sessionId)?.title || '新对话' }}</div>
        <div class="header-right">
          <select v-model="focusNovel" class="novel-select" title="本次会话的检索范围（已绑定到会话，切换自动恢复）" @change="onFocusChange">
            <option value="">🔍 全库检索</option>
            <option v-for="n in novelStore.list" :key="n.id" :value="n.title">📖 {{ n.title }}</option>
          </select>
          <div class="model">glm-4-flash · RAG · MCP</div>
        </div>
      </header>

      <div class="chat-area" ref="chatArea">
        <template v-if="chat.messages.value.length">
          <template v-for="m in chat.messages.value" :key="m.id">
            <!-- 工具时间线挂在自己所属的 assistant 消息上 -->
            <template v-if="m.role === 'assistant'">
              <ToolLine v-for="(t, j) in m.tools" :key="m.id + 't' + j" :name="t.name" :args="t.args" :error="t.error" />
            </template>
            <MessageBubble
              :role="m.role"
              :text="m.text"
              :reasoning="m.reasoning"
              :auto-open="m.id === lastMsgId && !m.fromHistory"
              :streaming="chat.streaming.value && m === chat.messages.value[chat.messages.value.length - 1]"
            />
          </template>
          <div v-if="chat.errorMsg.value" class="error-banner">❌ {{ chat.errorMsg.value }}</div>
          <div v-if="chat.streaming.value && chat.status.value" class="status-line">⏳ {{ chat.status.value }}</div>
        </template>

        <div v-else class="empty-state">
          <div class="big">问渠 Agent</div>
          <div class="desc">知识库语义问答（RAG）· 阅读数据分析 · 报告生成</div>
          <div class="quick">
            <button v-for="q in QUICK_QUESTIONS" :key="q" @click="chat.send(q)">{{ q }}</button>
          </div>
        </div>
      </div>

      <ChatInput
        ref="inputRef"
        :disabled="chat.streaming.value"
        :deep-mode="deepMode"
        @send="chat.send($event, { novelTitle: focusNovel || undefined, deep: resolveDeep($event) }, () => store.refresh())"
        @stop="chat.stop()"
        @cycle-deep="deepMode = deepMode === 'auto' ? 'deep' : deepMode === 'deep' ? 'fast' : 'auto'"
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
.model { font-size: 12px; color: var(--dim); background: var(--panel2); padding: 3px 10px; border-radius: 99px; flex-shrink: 0; }
.header-right { display: flex; align-items: center; gap: 10px; flex-shrink: 0; }
.novel-select {
  background: var(--panel2); border: 1px solid var(--border); border-radius: 99px;
  color: var(--text); font-size: 12px; padding: 3px 10px; outline: none; cursor: pointer;
  max-width: 180px;
}
.novel-select:focus { border-color: var(--accent); }
.chat-area { flex: 1; overflow-y: auto; padding: 20px; }
.error-banner {
  max-width: 780px; margin: 0 auto 16px; padding: 10px 14px;
  background: rgba(248,113,113,.1); border: 1px solid var(--err); border-radius: 8px;
  color: var(--err); font-size: 13px;
}
.status-line {
  max-width: 780px; margin: 0 auto 16px; text-align: center;
  color: var(--accent); font-size: 12px; animation: blink 1.6s infinite;
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
