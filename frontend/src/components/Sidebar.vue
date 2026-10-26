<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useSessionStore } from '../stores/sessions';
import { useNovelStore } from '../stores/novels';
import NovelUploadModal from './NovelUploadModal.vue';

const sessionStore = useSessionStore();
const novelStore = useNovelStore();
const uploadOpen = ref(false);

onMounted(() => novelStore.refresh());
</script>

<template>
  <aside class="sidebar">
    <div class="brand">
      <div class="logo">问</div>
      <div>
        <div class="name">问问 Agent</div>
        <div class="sub">小说分析 · 数据分析</div>
      </div>
    </div>
    <button class="new-chat" @click="sessionStore.create()">＋ 新对话</button>
    <div class="section-label">
      对话记录
    </div>
    <div class="session-list">
      <div
        v-for="s in sessionStore.list"
        :key="s.id"
        class="session-item"
        :class="{ active: s.id === sessionStore.currentId }"
        @click="$emit('select', s.id)"
      >
        <span class="title">{{ s.title }}</span>
        <button class="del" title="删除对话" @click.stop="sessionStore.remove(s.id)">✕</button>
      </div>
      <div v-if="!sessionStore.list.length" class="empty">暂无对话</div>

      <!-- 小说库：RAG 数据源管理 -->
      <div class="section-label novel-label">
        小说库
        <button class="add" title="上传小说" @click="uploadOpen = true">＋</button>
      </div>
      <div v-for="n in novelStore.list" :key="n.id" class="session-item novel">
        <span class="title">📖 {{ n.title }} <i>{{ n.chunkCount }}块</i></span>
        <button class="del" title="删除小说" @click.stop="novelStore.remove(n.id)">✕</button>
      </div>
    </div>

    <NovelUploadModal :open="uploadOpen" @close="uploadOpen = false" />
  </aside>
</template>

<style scoped>
.novel-label { display: flex; align-items: center; justify-content: space-between; margin-top: 10px; }
.add {
  background: transparent; border: 1px solid var(--border); border-radius: 5px;
  color: var(--dim); cursor: pointer; width: 20px; height: 20px; font-size: 12px; line-height: 1;
}
.add:hover { color: var(--accent); border-color: var(--accent); }
.session-item.novel .title i { font-style: normal; font-size: 11px; opacity: .6; margin-left: 4px; }
</style>


<style scoped>
.sidebar {
  width: 250px; flex-shrink: 0; background: var(--panel);
  border-right: 1px solid var(--border); display: flex; flex-direction: column;
}
.brand { display: flex; gap: 10px; align-items: center; padding: 16px; }
.logo {
  width: 34px; height: 34px; border-radius: 9px; flex-shrink: 0;
  background: linear-gradient(135deg, var(--accent), var(--accent2));
  display: flex; align-items: center; justify-content: center; font-weight: 600;
}
.name { font-weight: 600; }
.sub { font-size: 12px; color: var(--dim); }
.new-chat {
  margin: 0 12px 14px; padding: 9px; border: 1px dashed var(--border); border-radius: 8px;
  background: transparent; color: var(--text); cursor: pointer; transition: border-color .15s;
}
.new-chat:hover { border-color: var(--accent); }
.section-label { padding: 0 16px 6px; font-size: 11px; color: var(--dim); letter-spacing: .05em; }
.session-list { flex: 1; overflow-y: auto; padding: 0 8px 8px; }
.session-item {
  display: flex; align-items: center; justify-content: space-between; gap: 6px;
  padding: 8px 10px; border-radius: 7px; cursor: pointer; color: var(--dim); font-size: 13px;
}
.session-item:hover { background: var(--panel2); }
.session-item.active { background: var(--panel2); color: var(--text); }
.title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.del {
  flex-shrink: 0; width: 20px; height: 20px; border: none; border-radius: 5px;
  background: transparent; color: var(--dim); cursor: pointer; font-size: 12px; display: none;
}
.session-item:hover .del { display: block; }
.del:hover { color: var(--err); background: rgba(248,113,113,.12); }
.empty { color: var(--dim); font-size: 12px; text-align: center; padding: 20px 0; }
</style>
