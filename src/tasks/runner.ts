import { randomUUID } from 'node:crypto';
import {
  createTaskRow, finishTaskRow, getTaskRow, listTaskRows, updateTaskSteps,
  type TaskRow, type TaskStep,
} from '../db.js';
import { runDataAnalysis } from './jobs/dataAnalysis.js';
import { runNovelAnalysis } from './jobs/novelAnalysis.js';
import { chatLog } from '../logger.js';

/**
 * 长任务平台层：受理 → 后台执行 → 步骤进度落库 → 产物落库。
 * 剧本（jobs/）只定义「步骤做什么」，状态机、断点信息、取消都收敛在这里。
 * v1 进程内执行（单容器部署足够）；需要独立扩容时把 runner 拆成 worker 进程，接口不变。
 */

/** 剧本执行上下文：runner 传给剧本，剧本通过它汇报进度 */
export interface JobContext {
  taskId: string;
  /** 任务归属者（数据集等 owner 作用域资源的可见性判断用） */
  owner: string;
  /** 用户取消 / 服务关闭时置位，剧本在每个步骤边界检查 */
  signal: AbortSignal;
  /** 把当前步骤标为 running 并落库 */
  beginStep(name: string): Promise<void>;
  /** 完成当前步骤，携带中间产物摘要（前端展开可看） */
  finishStep(note?: string): Promise<void>;
  /** 当前任务参数（如聚焦的书名） */
  params: Record<string, unknown>;
}

type Job = (ctx: JobContext) => Promise<string>;

/** 剧本注册表：新增长任务场景 = 在 jobs/ 加文件 + 这里注册一行。
 * title 支持函数形式：按任务参数生成（如拼上数据源名），受理时求值一次 */
const JOBS: Record<string, { job: Job; title: string | ((params: Record<string, unknown>) => string); steps: string[] }> = {
  dataAnalysis: {
    job: runDataAnalysis,
    title: (p) => `《${(p.novelTitle as string) || '未知数据源'}》阅读数据分析报告`,
    steps: ['获取章节阅读数据', '趋势与异常检测', '问题章节原文归因', '生成分析报告'],
  },
  novelAnalysis: {
    job: runNovelAnalysis,
    title: (p) => `《${(p.novelTitle as string) || '未知作品'}》小说文本分析报告`,
    steps: ['生成文本画像', '编辑标准研判', '生成分析报告'],
  },
};

/** 进程内的取消句柄：taskId → AbortController */
const controllers = new Map<string, AbortController>();

export function startTask(type: string, owner: string, params: Record<string, unknown> = {}): TaskRow {
  const spec = JOBS[type];
  if (!spec) throw new Error(`未知任务类型: ${type}（可用: ${Object.keys(JOBS).join(', ')}）`);

  const id = `TASK-${Date.now().toString(36).toUpperCase()}`;
  const title = typeof spec.title === 'function' ? spec.title(params) : spec.title;
  const steps: TaskStep[] = spec.steps.map((name) => ({ name, status: 'pending' }));
  createTaskRow(id, type, title, owner, steps);

  const controller = new AbortController();
  controllers.set(id, controller);

  // 后台执行：受理即返回，进度走轮询。失败/取消都不抛出——状态已落库
  void execute(id, type, spec, steps, owner, params, controller);
  return getTaskRow(id, owner)!;
}

async function execute(
  id: string,
  type: string,
  spec: { job: Job },
  steps: TaskStep[],
  owner: string,
  params: Record<string, unknown>,
  controller: AbortController,
) {
  let cursor = -1; // 当前正在执行的步骤下标
  const persist = () => updateTaskSteps(id, steps);
  const ctx: JobContext = {
    taskId: id,
    owner,
    signal: controller.signal,
    params,
    async beginStep(name) {
      cursor = steps.findIndex((s) => s.name === name);
      if (cursor >= 0) {
        steps[cursor].status = 'running';
        await persist();
      }
    },
    async finishStep(note) {
      if (cursor >= 0) {
        steps[cursor].status = 'done';
        steps[cursor].note = note;
        await persist();
      }
    },
  };
  try {
    const result = await spec.job(ctx);
    if (controller.signal.aborted) {
      finishTaskRow(id, 'cancelled');
    } else {
      finishTaskRow(id, 'done', result);
    }
  } catch (err) {
    if (controller.signal.aborted) {
      finishTaskRow(id, 'cancelled');
    } else {
      const msg = err instanceof Error ? err.message : String(err);
      if (cursor >= 0) steps[cursor].status = 'failed';
      await persist();
      finishTaskRow(id, 'failed', undefined, msg.slice(0, 500));
      chatLog.error({ taskId: id, type, err: msg.slice(0, 300) }, '长任务执行失败');
    }
  } finally {
    controllers.delete(id);
  }
}

export function cancelTask(id: string, owner: string): boolean {
  const task = getTaskRow(id, owner);
  if (!task || task.status !== 'running') return false;
  controllers.get(id)?.abort();
  return true;
}

export { getTaskRow as getTask, listTaskRows as listTasks };
