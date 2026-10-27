import { defineStore } from 'pinia';
import { ref } from 'vue';

export interface SessionItem {
  id: string;
  title: string;
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

  return { list, currentId, refresh, create, remove, open };
});
