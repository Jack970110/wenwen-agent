<script setup lang="ts">
/**
 * 单个长任务卡片：进度条 + 步骤时间线 + 展开的报告。
 * 运行中自动展开步骤；完成后点击卡片展开/收起报告。
 */
import { ref } from 'vue';
import type { Task } from '../stores/tasks';

const props = defineProps<{ task: Task }>();
const emit = defineEmits<{ (e: 'cancel', id: string): void }>();

const expanded = ref(props.task.status === 'running'); // 运行中默认展开步骤
const STATUS_ICON: Record<string, string> = { pending: '⬜', running: '🔄', done: '✅', failed: '❌' };
const TASK_STATUS: Record<string, string> = { running: '运行中', done: '已完成', failed: '失败', cancelled: '已取消' };

function pct(t: Task): number {
  const done = t.steps.filter((s) => s.status === 'done').length;
  return Math.round((done / Math.max(t.steps.length, 1)) * 100);
}

function toggle() {
  if (props.task.status === 'running') return; // 运行中固定展开
  expanded.value = !expanded.value;
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
  <div class="task-card">
    <div class="task-head" @click="toggle">
      <span class="t-icon">{{ task.status === 'running' ? '⏳' : task.status === 'done' ? '📄' : '⚠️' }}</span>
      <span class="t-title">{{ task.title }}</span>
      <span class="t-time">{{ task.createdAt.slice(5, 16) }}</span>
      <span class="t-status" :data-status="task.status">
        {{ TASK_STATUS[task.status] }} {{ task.status === 'running' ? pct(task) + '%' : '' }}
      </span>
      <button v-if="task.status === 'running'" class="t-cancel" title="取消任务" @click.stop="emit('cancel', task.id)">✕</button>
    </div>

    <div v-if="task.status === 'running'" class="bar"><div class="bar-fill" :style="{ width: pct(task) + '%' }"></div></div>

    <div v-if="expanded" class="steps">
      <div v-for="s in task.steps" :key="s.name" class="step">
        <span class="s-icon">{{ STATUS_ICON[s.status] }}</span>
        <span class="s-name" :class="s.status">{{ s.name }}</span>
        <span v-if="s.note && s.status !== 'pending'" class="s-note">{{ s.note }}</span>
      </div>
      <div v-if="task.error" class="t-error">❌ {{ task.error }}</div>
    </div>

    <div v-if="expanded && task.result" class="report">{{ task.result }}</div>
    <div v-if="expanded && task.result" class="report-actions">
      <button class="export" @click.stop="exportMd(task)">⬇ 导出 Markdown</button>
    </div>
  </div>
</template>

<style scoped>
.task-card {
  background: var(--panel); border: 1px solid var(--border); border-radius: 12px;
  padding: 12px 16px; cursor: pointer;
}
.task-head { display: flex; align-items: center; gap: 8px; }
.t-icon { flex-shrink: 0; }
.t-title { font-weight: 600; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.t-time { font-size: 12px; color: var(--dim); flex-shrink: 0; }
.t-status { font-size: 12px; color: #888; flex-shrink: 0; }
.t-status[data-status='running'] { color: #d48806; }
.t-status[data-status='done'] { color: #389e0d; }
.t-status[data-status='failed'] { color: #cf1322; }
.t-cancel { border: none; background: none; cursor: pointer; color: #999; flex-shrink: 0; }
.t-cancel:hover { color: var(--err); }
.bar { height: 4px; background: var(--border); border-radius: 2px; margin-top: 10px; overflow: hidden; }
.bar-fill { height: 100%; background: linear-gradient(90deg, var(--accent), var(--accent2)); transition: width .5s; }
.steps { margin-top: 10px; display: flex; flex-direction: column; gap: 5px; }
.step { display: flex; align-items: baseline; gap: 8px; font-size: 13px; }
.s-icon { flex-shrink: 0; }
.s-name { white-space: nowrap; }
.s-name.running { color: #d48806; }
.s-name.done { color: var(--text); }
.s-name.failed { color: #cf1322; }
.s-note { font-size: 12px; color: var(--dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
.t-error { font-size: 13px; color: #cf1322; margin-top: 4px; }
.report {
  margin-top: 12px; padding: 14px; background: var(--panel2); border-radius: 8px;
  white-space: pre-wrap; font-size: 13px; line-height: 1.75; max-height: 480px; overflow-y: auto;
  cursor: text;
}
.report-actions { margin-top: 8px; text-align: right; }
.export {
  border: 1px solid var(--border); background: transparent; border-radius: 7px;
  padding: 4px 10px; font-size: 12px; color: var(--dim); cursor: pointer;
}
.export:hover { color: var(--accent); border-color: var(--accent); }
</style>
