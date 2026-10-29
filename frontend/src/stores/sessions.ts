import { defineStore } from 'pinia';
import { ref } from 'vue';

export interface SessionItem {
  id: string;
  title: string;
  focusNovel: string | null;
  createdAt: string;
}

export const useSessionStore = defineStore('sessions', () => {
  const list = ref<SessionItem[]>([]);
  const currentId = ref('');

  async function refresh() {
    const res = await fetch('/api/sessions');
    if (res.status === 401) { location.href = '/login'; return; }
    list.value = await res.json();
  }

  async function create(): Promise<string> {
    const { sessionId } = await (await fetch('/api/sessions', { method: 'POST' })).json();
    currentId.value = sessionId;
    await refresh();
    return sessionId;
  }

  async function remove(id: string) {
    await fetch(`/api/sessions/${id}`, { method: 'DELETE' });
    if (id === currentId.value) await create();
    else await refresh();
  }

  async function open(id: string) {
    currentId.value = id;
    await refresh();
  }

  /** 会话级聚焦小说：写入会话，切回来自动恢复（null = 全库检索） */
  async function setFocus(id: string, novelTitle: string | null) {
    await fetch(`/api/sessions/${id}/focus`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ novelTitle }),
    });
    await refresh();
  }

  return { list, currentId, refresh, create, remove, open, setFocus };
});
