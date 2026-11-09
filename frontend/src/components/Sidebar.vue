<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useSessionStore } from '../stores/sessions';
import { useNovelStore } from '../stores/novels';
import { useTaskStore, type Task } from '../stores/tasks';
import { useAnalysisStore } from '../stores/analysis';
import { fetchMe, isAdmin, logout, username } from '../stores/me';
import NovelUploadModal from './NovelUploadModal.vue';
import ImportDatasetModal from './ImportDatasetModal.vue';

const sessionStore = useSessionStore();
const novelStore = useNovelStore();
const taskStore = useTaskStore();
const analysisStore = useAnalysisStore();
const uploadOpen = ref(false);

const props = defineProps<{ view?: string }>();
defineEmits<{ (e: 'select', id: string): void; (e: 'view', v: string): void }>();

const progressPct = computed(() => {
  const j = novelStore.activeJob;
  return j && j.total > 0 ? Math.round((j.embedded / j.total) * 100) : 0;
});

function removeNovel(n: { id: string; title: string }) {
  // 删除不可恢复（向量/摘要/梗概一并清掉），必须有二次确认
  if (window.confirm(`确定删除《${n.title}》？全部向量与摘要将一并删除，不可恢复。`)) {
    novelStore.remove(n.id);
  }
}

const TASK_STATUS: Record<string, string> = { running: '运行中', done: '已完成', failed: '失败', cancelled: '已取消' };
const TASK_ICON: Record<string, string> = { running: '⏳', done: '📄', failed: '⚠️', cancelled: '🚫' };

function taskPct(t: Task): number {
  const done = t.steps.filter((s) => s.status === 'done').length;
  return Math.round((done / Math.max(t.steps.length, 1)) * 100);
}

/** 按来源 tab 发起对应剧本：dataset→阅读数据分析；novel→小说文本分析 */
async function createAnalysis() {
  if (taskStore.running) return;
  if (analysisStore.sourceTab === 'novel') {
    if (!analysisStore.selectedNovel) return;
    await taskStore.create('novelAnalysis', {
      novelTitle: analysisStore.selectedNovel,
      datasetName: analysisStore.novelDataset || undefined,
    });
  } else {
    if (!analysisStore.selectedSource) return;
    await taskStore.create('dataAnalysis', { novelTitle: analysisStore.selectedSource });
  }
}

/** 切到分析视图时拉数据源和任务列表（视图区内容随 view 切换） */
async function loadAnalysis() {
  if (props.view === 'analysis') {
    taskStore.refresh();
    analysisStore.loadSources();
  }
}
watch(() => props.view, loadAnalysis);

onMounted(() => novelStore.resume());
</script>

<template>
  <aside class="sidebar">
    <div class="brand">
      <div class="logo">问</div>
      <div>
        <div class="name">问渠 Agent</div>
        <div class="sub">知识库问答 · 分析</div>
      </div>
    </div>
    <!-- 一级导航：两种独立工作流——问答在对话里，数据/报告在分析页 -->
    <div class="nav">
      <button :class="{ active: view !== 'analysis' }" @click="$emit('view', 'chat')">💬 对话</button>
      <button :class="{ active: view === 'analysis' }" @click="$emit('view', 'analysis')">📊 分析</button>
    </div>
    <!-- 视图区：内容随一级导航切换（chat=对话记录+知识库；analysis=数据源+任务列表） -->
    <template v-if="view !== 'analysis'">
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

      <!-- 小说库：游客只读公开演示库；管理员可上传/删除 -->
      <div class="section-label novel-label">
        {{ isAdmin ? '知识库' : '演示知识库' }}
        <button v-if="isAdmin" class="add" title="上传文档" @click="uploadOpen = true">＋</button>
      </div>
      <div v-if="novelStore.ingestError" class="ingest-msg err">{{ novelStore.ingestError }}</div>
      <!-- 全局入库进度：提交后即显示，关弹窗/刷新不丢（store 持久化） -->
      <div v-if="novelStore.activeJob" class="ingest-progress">
        <div class="row">
          <span class="t">⏳ {{ novelStore.activeJob.title }}</span>
          <span class="pct" v-if="novelStore.activeJob.total > 0">
            {{ Math.round((novelStore.activeJob.embedded / novelStore.activeJob.total) * 100) }}%
          </span>
        </div>
        <div class="stage">
          {{ novelStore.activeJob.total > 0
            ? `${novelStore.activeJob.stage === 'summarizing' ? '生成摘要' : '向量化'} ${novelStore.activeJob.embedded}/${novelStore.activeJob.total}`
            : '切块中…' }}
        </div>
        <div class="bar">
          <div class="bar-fill" :style="{ width: progressPct + '%' }"></div>
        </div>
      </div>
      <div v-for="n in novelStore.list" :key="n.id" class="session-item novel">
        <span class="title">
          📖 {{ n.title }}
          <i v-if="n.status === 'ingesting'">入库中…</i>
          <i v-else>{{ n.chunkCount }}块</i>
        </span>
        <span class="ops" v-if="isAdmin">
          <button
            class="pub"
            :class="{ on: n.owner === 'public' }"
            :title="n.owner === 'public' ? '公开中（游客可见），点击取消公开' : '点击公开，游客即可体验该知识库'"
            @click.stop="novelStore.setOwner(n.id, n.owner === 'public' ? 'admin' : 'public')"
          >{{ n.owner === 'public' ? '取消公开' : '公开' }}</button>
          <button class="del" title="删除该知识库" @click.stop="removeNovel(n)">删除</button>
        </span>
      </div>
      <div v-if="!isAdmin" class="empty guest-tip">体验版仅含演示文档</div>
      </div>
    </template>

    <!-- 分析视图区：数据源/知识库 + 任务列表（与右侧 AnalysisView 详情页共用 store） -->
    <template v-else>
      <div class="session-list">
        <!-- 来源切换：两类剧本的分析对象不同——阅读数据走数据集，文本分析走知识库 -->
        <div class="source-tabs">
          <button :class="{ active: analysisStore.sourceTab === 'dataset' }" @click="analysisStore.sourceTab = 'dataset'">📈 数据</button>
          <button :class="{ active: analysisStore.sourceTab === 'novel' }" @click="analysisStore.sourceTab = 'novel'">📖 知识库</button>
        </div>

        <template v-if="analysisStore.sourceTab === 'dataset'">
          <div class="section-label novel-label">
            阅读数据集
            <button v-if="isAdmin" class="add" title="上传 CSV 数据" @click="analysisStore.importOpen = true">＋</button>
          </div>
          <div
            v-for="d in analysisStore.sources"
            :key="d.id"
            class="session-item"
            :class="{ active: d.name === analysisStore.selectedSource }"
            @click="analysisStore.selectedSource = d.name"
          >
            <span class="title">{{ d.name }}</span>
            <span class="ops" v-if="isAdmin">
              <i class="rows">{{ d.rowCount }}行</i>
              <button
                class="pub"
                :class="{ on: d.owner === 'public' }"
                :title="d.owner === 'public' ? '公开中，点击取消' : '点击公开给其他管理员'"
                @click.stop="analysisStore.toggleOwner(d)"
              >{{ d.owner === 'public' ? '取消公开' : '公开' }}</button>
              <button class="del" title="删除数据集" @click.stop="analysisStore.removeDataset(d.id)">删除</button>
            </span>
          </div>
          <div v-if="!analysisStore.sources.length" class="empty">暂无数据源</div>
        </template>

        <template v-else>
          <div class="section-label novel-label">知识库小说</div>
          <div
            v-for="n in novelStore.list"
            :key="n.id"
            class="session-item"
            :class="{ active: n.title === analysisStore.selectedNovel }"
            @click="analysisStore.selectedNovel = n.title"
          >
            <span class="title">📖 {{ n.title }}</span>
            <span class="ops"><i class="rows">{{ n.chunkCount }}块</i></span>
          </div>
          <div v-if="!novelStore.list.length" class="empty">知识库为空</div>
          <!-- 可选关联阅读数据集：'' = 自动匹配（唯一候选才采用），匹配不到纯文本分析 -->
          <div v-if="analysisStore.selectedNovel && analysisStore.sources.length" class="ds-link">
            <label>关联阅读数据（可选）</label>
            <select v-model="analysisStore.novelDataset">
              <option value="">自动匹配</option>
              <option v-for="d in analysisStore.sources" :key="d.id" :value="d.name">{{ d.name }}</option>
            </select>
          </div>
        </template>

        <button
          v-if="isAdmin"
          class="create-btn"
          :disabled="(!analysisStore.selectedSource && analysisStore.sourceTab === 'dataset') || (!analysisStore.selectedNovel && analysisStore.sourceTab === 'novel') || !!taskStore.running"
          :title="taskStore.running ? '已有任务在运行中' : ''"
          @click="createAnalysis"
        >{{ taskStore.running ? '任务运行中…' : '＋ 生成分析报告' }}</button>

        <div class="section-label novel-label">分析任务</div>
        <div
          v-for="t in taskStore.list"
          :key="t.id"
          class="session-item"
          :class="{ active: t.id === taskStore.selectedId }"
          @click="taskStore.select(t.id)"
        >
          <span class="title">{{ TASK_ICON[t.status] }} {{ t.title }}</span>
          <span class="ops">
            <i class="rows">{{ TASK_STATUS[t.status] }}{{ t.status === 'running' ? ` ${taskPct(t)}%` : '' }}</i>
            <button v-if="t.status === 'running'" class="del" title="取消任务" @click.stop="taskStore.cancel(t.id)">✕</button>
          </span>
        </div>
        <div v-if="!taskStore.list.length" class="empty">暂无分析任务</div>
        <div v-if="!isAdmin" class="empty guest-tip">长任务与数据导入仅管理员可用</div>
      </div>
      <ImportDatasetModal :open="analysisStore.importOpen" :existing-names="analysisStore.sources.map(d => d.name)" @close="analysisStore.importOpen = false" @imported="analysisStore.loadSources()" />
    </template>

    <!-- 身份区：游客给管理员登录入口；管理员显示身份和退出 -->
    <div class="identity">
      <template v-if="isAdmin">
        <span class="badge admin">👑 {{ username || '管理员' }}</span>
        <button class="logout" @click="logout()">退出</button>
      </template>
      <template v-else>
        <span class="badge guest">👤 游客模式</span>
        <a class="login-link" href="/login">管理员登录</a>
      </template>
    </div>

    <NovelUploadModal :open="uploadOpen" @close="uploadOpen = false" />
  </aside>
</template>

<style scoped>
.identity {
  margin: 0 12px 12px; padding: 10px 12px;
  background: var(--panel2); border: 1px solid var(--border); border-radius: 9px;
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
}
.badge { font-size: 12px; color: var(--dim); }
.badge.admin { color: var(--accent2); }
.logout, .login-link {
  font-size: 12px; color: var(--accent); text-decoration: none;
  background: transparent; border: none; cursor: pointer; padding: 0;
}
.logout:hover, .login-link:hover { text-decoration: underline; }
</style>

<style scoped>
.novel-label { display: flex; align-items: center; justify-content: space-between; margin-top: 10px; }
.add {
  background: transparent; border: 1px solid var(--border); border-radius: 5px;
  color: var(--dim); cursor: pointer; width: 20px; height: 20px; font-size: 12px; line-height: 1;
}
.add:hover { color: var(--accent); border-color: var(--accent); }
.session-item.novel .title i { font-style: normal; font-size: 11px; opacity: .6; margin-left: 4px; }
.ops { display: none; align-items: center; gap: 4px; flex-shrink: 0; }
.session-item:hover .ops { display: flex; }
.ops .pub, .ops .del {
  border: none; border-radius: 5px; padding: 2px 6px;
  background: transparent; color: var(--dim); cursor: pointer; font-size: 11px; white-space: nowrap;
}
.ops .pub.on { color: var(--accent2); }
.ops .pub:hover { color: var(--accent); }
.ops .del:hover { color: var(--err); background: rgba(248,113,113,.12); }
.ingest-progress {
  margin: 4px 8px 8px; padding: 8px 10px;
  background: var(--panel2); border: 1px solid var(--border); border-radius: 8px;
}
.ingest-progress .row { display: flex; justify-content: space-between; gap: 6px; }
.ingest-progress .t { font-size: 12px; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ingest-progress .pct { font-size: 12px; color: var(--accent2); flex-shrink: 0; }
.ingest-progress .stage { font-size: 11px; color: var(--dim); margin: 2px 0 6px; }
.ingest-progress .bar { height: 4px; background: var(--bg); border-radius: 3px; overflow: hidden; }
.ingest-progress .bar-fill { height: 100%; background: linear-gradient(90deg, var(--accent), var(--accent2)); transition: width .6s; }
.ingest-msg { font-size: 12px; margin: 4px 8px 8px; padding: 8px 10px; border-radius: 8px; }
.ingest-msg.err { background: rgba(248,113,113,.1); color: var(--err); border: 1px solid rgba(248,113,113,.3); }
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
.nav { display: flex; gap: 6px; margin: 0 12px 10px; }
.nav button {
  flex: 1; padding: 8px 0; border-radius: 8px; font-size: 13px; cursor: pointer;
  border: 1px solid var(--border); background: transparent; color: var(--dim);
}
.nav button.active { background: var(--panel2); color: var(--text); border-color: var(--accent2); }
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
/* 分析视图区：复用 session-item，仅补数据源/任务的小字与创建按钮 */
.ops .rows { font-style: normal; font-size: 11px; opacity: .7; white-space: nowrap; }
.source-tabs { display: flex; gap: 4px; margin: 2px 4px 8px; }
.source-tabs button {
  flex: 1; padding: 6px 0; border-radius: 7px; font-size: 12px; cursor: pointer;
  border: 1px solid var(--border); background: transparent; color: var(--dim);
}
.source-tabs button.active { background: var(--panel2); color: var(--text); border-color: var(--accent2); }
.ds-link { margin: 6px 4px 0; }
.ds-link label { display: block; font-size: 11px; color: var(--dim); margin-bottom: 3px; }
.ds-link select {
  width: 100%; padding: 6px 8px; border-radius: 7px; font-size: 12px;
  border: 1px solid var(--border); background: var(--panel2); color: var(--text);
}
.create-btn {
  margin: 10px 4px 4px; padding: 9px; border-radius: 8px; font-size: 13px; cursor: pointer;
  border: 1px dashed var(--accent2); background: transparent; color: var(--accent2);
}
.create-btn:hover:not(:disabled) { background: rgba(139,108,255,.1); }
.create-btn:disabled { opacity: .45; cursor: not-allowed; }
</style>
