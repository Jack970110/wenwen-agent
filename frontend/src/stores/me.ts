import { ref } from 'vue';

/** 当前访问者身份：admin = 登录的管理员（用户名在 username）；guest = 游客（免登录体验） */
export const isAdmin = ref(false);
export const username = ref('');

export async function fetchMe() {
  try {
    const res = await fetch('/api/me');
    if (res.ok) {
      const me = await res.json();
      isAdmin.value = me.admin;
      username.value = me.username || '';
    }
  } catch { /* 网络异常时按游客处理 */ }
}

export async function logout() {
  await fetch('/api/logout', { method: 'POST' });
  isAdmin.value = false;
  username.value = '';
  location.href = '/'; // 回到游客视角
}
