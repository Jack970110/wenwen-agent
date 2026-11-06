<script setup lang="ts">
/**
 * 数据分析详情页：Sidebar（数据源 + 任务列表）选中任务后，这里展示
 * 步骤时间线和最终报告（markdown 渲染）。布局职责：
 * - Sidebar 分析视图区 = 资源与任务导航
 * - 本页 = 任务详情（进度 / 报告阅读 / 导出）
 */
import { computed } from 'vue';
import MarkdownIt from 'markdown-it';
import { useTaskStore, type Task } from '../stores/tasks';

const md = new MarkdownIt({ breaks: true });
const taskStore = useTaskStore();
const task = computed(() => taskStore.selected);

const STATUS_ICON: Record<string, string> = { pending: '⬜', running: '🔄', done: '✅', failed: '❌' };
const TASK_STATUS: Record<string, string> = { running: '运行中', done: '已完成', failed: '失败', cancelled: '已取消' };

function pct(t: Task): number {
  const done = t.steps.filter((s) => s.status === 'done').length;
  return Math.round((done / Math.max(t.steps.length, 1)) * 100);
}

/** 报告导出为 .md（客户端生成，零后端依赖） */
function exportMd(t: Task) {
  const url = URL.createObjectURL(new Blob([t.result ?? ''], { type: 'text/markdown;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `${t.title}-${t.id}.md`;
  a.click();
  URL.revokeObjectURL(url);
}
</script>

<template>
  <main class="analysis">
    <template v-if="task">
      <header>
        <div class="page-title">{{ task.status === 'running' ? '⏳' : task.status === 'done' ? '📄' : '⚠️' }} {{ task.title }}</div>
        <div class="model">
          {{ TASK_STATUS[task.status] }}
          <template v-if="task.status === 'running'"> · {{ pct(task) }}%</template>
          · {{ task.createdAt.slice(5, 16) }}
        </div>
      </header>

      <div class="detail">
        <div v-if="task.status === 'running'" class="bar"><div class="bar-fill" :style="{ width: pct(task) + '%' }"></div></div>

        <!-- 步骤时间线 -->
        <div class="steps">
          <div v-for="s in task.steps" :key="s.name" class="step">
            <span class="s-icon">{{ STATUS_ICON[s.status] }}</span>
            <span class="s-name" :class="s.status">{{ s.name }}</span>
            <span v-if="s.note && s.status !== 'pending'" class="s-note">{{ s.note }}</span>
          </div>
          <div v-if="task.error" class="t-error">❌ {{ task.error }}</div>
        </div>

        <!-- 报告正文：markdown 渲染（与对话气泡同一渲染配置） -->
        <div v-if="task.result" class="report md" v-html="md.render(task.result)"></div>
        <div v-if="task.result" class="report-actions">
          <button class="export" @click="exportMd(task)">⬇ 导出 Markdown</button>
        </div>
      </div>
    </template>

    <!-- 未选中任务 / 无任务的引导空态 -->
    <div v-else class="big-empty">
      <div class="big">选择一个分析任务</div>
      <div class="desc">在左侧选择数据源后点击「生成分析报告」发起长任务；任务在后台运行，可以离开本页，回来点击任务即可查看进度和报告。</div>
    </div>
  </main>
</template>

<style scoped>
.analysis { flex: 1; display: flex; flex-direction: column; min-width: 0; }
header {
  padding: 12px 20px; border-bottom: 1px solid var(--border);
  display: flex; align-items: center; justify-content: space-between;
}
.page-title { font-weight: 600; font-size: 14px; }
.model { font-size: 12px; color: var(--dim); background: var(--panel2); padding: 3px 10px; border-radius: 99px; }
.detail { flex: 1; overflow-y: auto; padding: 20px; display: flex; flex-direction: column; gap: 14px; }
.bar { height: 4px; background: var(--border); border-radius: 2px; overflow: hidden; }
.bar-fill { height: 100%; background: linear-gradient(90deg, var(--accent), var(--accent2)); transition: width .5s; }
.steps { display: flex; flex-direction: column; gap: 6px; background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 12px 14px; }
.step { display: flex; align-items: baseline; gap: 8px; font-size: 13px; }
.s-icon { flex-shrink: 0; }
.s-name { white-space: nowrap; }
.s-name.running { color: #d48806; }
.s-name.done { color: var(--text); }
.s-name.failed { color: #cf1322; }
.s-note { font-size: 12px; color: var(--dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
.t-error { font-size: 13px; color: #cf1322; }
.report { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 18px 20px; font-size: 14px; line-height: 1.8; }
/* 报告 markdown 排版（MessageBubble 的样式是 scoped 的，这里独立补一份） */
.report :deep(h1), .report :deep(h2), .report :deep(h3) { font-size: 15px; margin: 14px 0 8px; }
.report :deep(h1:first-child), .report :deep(h2:first-child) { margin-top: 0; }
.report :deep(p) { margin: 8px 0; }
.report :deep(ul), .report :deep(ol) { margin: 8px 0; padding-left: 22px; }
.report :deep(li) { margin: 3px 0; }
.report :deep(blockquote) { margin: 8px 0; padding: 6px 12px; border-left: 3px solid var(--border); color: var(--dim); }
.report :deep(code) { background: var(--panel2); border-radius: 4px; padding: 1px 5px; font-size: 13px; }
.report :deep(table) { border-collapse: collapse; margin: 8px 0; }
.report :deep(th), .report :deep(td) { border: 1px solid var(--border); padding: 5px 10px; font-size: 13px; }
.report-actions { text-align: right; }
.export {
  border: 1px solid var(--border); background: transparent; border-radius: 7px;
  padding: 5px 12px; font-size: 12px; color: var(--dim); cursor: pointer;
}
.export:hover { color: var(--accent); border-color: var(--accent); }
.big-empty { flex: 1; display: flex; flex-direction: column; justify-content: center; text-align: center; padding: 40px; }
.big { font-size: 16px; font-weight: 600; color: var(--text); margin-bottom: 8px; }
.desc { max-width: 420px; margin: 0 auto; line-height: 1.7; color: var(--dim); font-size: 13px; }
</style>
