import { defineStore } from 'pinia';

/**
 * 长任务状态：轮询 /api/tasks 驱动（长任务不走 SSE——受理即返回，进度落库轮询）。
 * 有运行中任务时 3s 快轮询，空闲时 12s 慢轮询维持列表新鲜。
 */
export interface TaskStep {
  name: string;
  status: 'pending' | 'running' | 'done' | 'failed';
  note?: string;
}

export interface Task {
  id: string;
  type: string;
  title: string;
  status: 'running' | 'done' | 'failed' | 'cancelled';
  steps: TaskStep[];
  result?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export const useTaskStore = defineStore('tasks', {
  state: () => ({
    list: [] as Task[],
    expanded: '' as string, // 当前展开查看报告的任务 id
    /** Sidebar 选中查看详情的任务；轮询刷新后仍按 id 取最新 */
    selectedId: '' as string,
    timer: null as ReturnType<typeof setInterval> | null,
  }),
  getters: {
    running: (s) => s.list.find((t) => t.status === 'running'),
    latest: (s) => s.list[0],
    /** 详情页当前任务：按 id 从最新列表取（轮询自动更新进度/结果） */
    selected: (s): Task | undefined => s.list.find((t) => t.id === s.selectedId),
    /** 面板显隐：有任务才显示（最新任务优先展示） */
    visible(): boolean { return this.list.length > 0; },
  },
  actions: {
    async refresh() {
      try {
        const res = await fetch('/api/tasks');
        if (res.ok) this.list = await res.json();
      } catch { /* 网络异常保持原状 */ }
      this.schedule();
    },
    schedule() {
      if (this.timer) clearInterval(this.timer);
      const interval = this.running ? 3000 : 12000;
      this.timer = setInterval(() => this.refresh(), interval);
    },
    async create(type: string, params: Record<string, unknown> = {}): Promise<Task | null> {
      const res = await fetch('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, params }),
      });
      if (!res.ok) return null;
      const task: Task = await res.json();
      this.list.unshift(task);
      this.selectedId = task.id;
      this.schedule();
      return task;
    },
    select(id: string) { this.selectedId = id; },
    async cancel(id: string) {
      await fetch(`/api/tasks/${id}/cancel`, { method: 'POST' });
      await this.refresh();
    },
    async remove(id: string) {
      await fetch(`/api/tasks/${id}`, { method: 'DELETE' });
      if (this.selectedId === id) this.selectedId = '';
      await this.refresh();
    },
  },
});
