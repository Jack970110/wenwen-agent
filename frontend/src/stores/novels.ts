import { defineStore } from 'pinia';
import { ref } from 'vue';

export interface NovelItem {
  id: string;
  title: string;
  chunkCount: number;
  status?: string; // ingesting = 入库中（列表显示进度占位）
}

/** 进行中的入库任务：持久化到 localStorage，关弹窗/刷新页面后进度继续显示 */
export interface ActiveIngest {
  jobId: string;
  title: string;
  stage: string;
  embedded: number;
  total: number;
}

const ACTIVE_KEY = 'wenqu-ingest-job';

function loadActive(): ActiveIngest | null {
  try {
    return JSON.parse(localStorage.getItem(ACTIVE_KEY) || 'null');
  } catch {
    return null;
  }
}

export const useNovelStore = defineStore('novels', () => {
  const list = ref<NovelItem[]>([]);
  const uploadError = ref('');
  /** 全局入库进度（侧边栏展示）：弹窗关闭/页面刷新后依然存活 */
  const activeJob = ref<ActiveIngest | null>(loadActive());
  /** 入库失败信息（全局展示，替代只在弹窗里可见的错误） */
  const ingestError = ref('');

  let timer: ReturnType<typeof setInterval> | null = null;

  async function refresh() {
    list.value = await (await fetch('/api/novels')).json();
  }

  /**
   * 全局进度看护：轮询任务状态直到完成/失败。
   * 为什么独立于弹窗：向量化要几分钟，用户没义务守着弹窗——
   * 进度挂在 store 上（localStorage 持久化），关弹窗、切页面、刷新都不断。
   */
  function watchJob(jobId: string) {
    if (timer) clearInterval(timer);
    timer = setInterval(async () => {
      if (!activeJob.value) return stopWatch();
      try {
        const res = await fetch(`/api/novels/jobs/${jobId}`);
        if (res.status === 404) {
          // 任务丢失 = 服务重启过；列表里的 ingesting 状态会被服务端启动自愈清理
          ingestError.value = '入库任务丢失（服务重启过），请重新上传';
          return finish();
        }
        const job = await res.json();
        activeJob.value = { ...activeJob.value, stage: job.stage || '', embedded: job.embedded, total: job.total };
        if (job.status === 'done') {
          ingestError.value = '';
          await refresh();
          return finish();
        }
        if (job.status === 'error') {
          ingestError.value = `《${activeJob.value.title}》入库失败：${job.error || '未知错误'}`;
          await refresh();
          return finish();
        }
      } catch {
        // 网络抖动：不清任务，下一轮继续
      }
    }, 1500);
  }

  function finish() {
    localStorage.removeItem(ACTIVE_KEY);
    activeJob.value = null;
    stopWatch();
  }

  function stopWatch() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  /** 提交上传后立即返回（进度走全局看护，弹窗可随手关闭） */
  async function upload(title: string, file: File): Promise<boolean> {
    uploadError.value = '';
    ingestError.value = '';
    try {
      const fd = new FormData();
      fd.append('title', title);
      fd.append('file', file);
      const res = await fetch('/api/novels', { method: 'POST', body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

      activeJob.value = { jobId: data.jobId, title, stage: 'vectorizing', embedded: 0, total: 0 };
      localStorage.setItem(ACTIVE_KEY, JSON.stringify(activeJob.value));
      watchJob(data.jobId);
      return true;
    } catch (e: any) {
      uploadError.value = e.message || '上传失败';
      return false;
    }
  }

  /** 应用启动：恢复上次未看完的入库进度（服务端任务可能已完成） */
  async function resume() {
    await refresh();
    if (activeJob.value) {
      // 已完成的任务（如刷新发生在入库完成之后）：直接收尾
      const target = list.value.find((n) => n.title === activeJob.value!.title);
      if (target && target.status !== 'ingesting') return finish();
      watchJob(activeJob.value.jobId);
    }
  }

  async function remove(id: string) {
    await fetch(`/api/novels/${id}`, { method: 'DELETE' });
    await refresh();
  }

  return { list, uploadError, ingestError, activeJob, refresh, upload, resume, remove };
});
