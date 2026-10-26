import { defineStore } from 'pinia';
import { ref } from 'vue';

export interface NovelItem {
  id: string;
  title: string;
  chunkCount: number;
}

export const useNovelStore = defineStore('novels', () => {
  const list = ref<NovelItem[]>([]);
  const uploading = ref(false);
  const uploadMsg = ref('');
  const uploadError = ref('');
  /** 入库进度：embedded/total 块，-1 表示未知 */
  const progress = ref({ embedded: 0, total: 0 });

  async function refresh() {
    list.value = await (await fetch('/api/novels')).json();
  }

  /**
   * 上传 → 拿 jobId → 轮询任务进度直到完成/失败。
   * 长篇向量化要几分钟，必须异步 + 进度反馈，不能让请求挂着。
   */
  async function upload(title: string, file: File): Promise<boolean> {
    uploading.value = true;
    uploadError.value = '';
    uploadMsg.value = '切块中…';
    progress.value = { embedded: 0, total: 0 };
    try {
      const fd = new FormData();
      fd.append('title', title);
      fd.append('file', file);
      const res = await fetch('/api/novels', { method: 'POST', body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

      // 轮询任务状态
      while (true) {
        await new Promise((r) => setTimeout(r, 1500));
        const jobRes = await fetch(`/api/novels/jobs/${data.jobId}`);
        const job = await jobRes.json();
        if (jobRes.status === 404) throw new Error('任务丢失（服务可能重启过），请重新上传');

        progress.value = { embedded: job.embedded, total: job.total };
        if (job.total > 0) uploadMsg.value = `向量化中 ${job.embedded}/${job.total} 块…`;

        if (job.status === 'done') {
          uploadMsg.value = `✅ 入库成功：${job.total} 个文本块`;
          await refresh();
          return true;
        }
        if (job.status === 'error') throw new Error(job.error || '入库失败');
      }
    } catch (e: any) {
      uploadError.value = e.message || '上传失败';
      uploadMsg.value = '';
      return false;
    } finally {
      uploading.value = false;
    }
  }

  async function remove(id: string) {
    await fetch(`/api/novels/${id}`, { method: 'DELETE' });
    await refresh();
  }

  return { list, uploading, uploadMsg, uploadError, progress, refresh, upload, remove };
});
