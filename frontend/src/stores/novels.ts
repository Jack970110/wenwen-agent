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

  async function refresh() {
    list.value = await (await fetch('/api/novels')).json();
  }

  /** 上传入库：FormData 走文件上传，同步等待 embedding 完成 */
  async function upload(title: string, file: File): Promise<boolean> {
    uploading.value = true;
    uploadMsg.value = '切块并向量化中，可能需要几十秒…';
    uploadError.value = '';
    try {
      const fd = new FormData();
      fd.append('title', title);
      fd.append('file', file);
      const res = await fetch('/api/novels', { method: 'POST', body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      uploadMsg.value = `✅ 入库成功：${data.chunkCount} 个文本块`;
      await refresh();
      return true;
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

  return { list, uploading, uploadMsg, uploadError, refresh, upload, remove };
});
