<script setup lang="ts">
import { ref } from 'vue';

const emit = defineEmits<{ (e: 'success'): void }>();

const username = ref('');
const password = ref('');
const error = ref('');
const loading = ref(false);

async function login() {
  if (loading.value || !username.value.trim() || !password.value) return;
  loading.value = true;
  error.value = '';
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: username.value.trim(), password: password.value }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({ error: '登录失败' }));
      throw new Error(data.error || '登录失败');
    }
    emit('success');
  } catch (e: any) {
    error.value = e.message || '登录失败';
  } finally {
    loading.value = false;
  }
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter') login();
}
</script>

<template>
  <div class="login-page">
    <div class="card">
      <h1>问渠 Agent</h1>
      <p>私有部署站点，管理员登录</p>
      <input v-model="username" type="text" placeholder="用户名" autofocus @keydown="onKeydown">
      <input v-model="password" type="password" placeholder="密码" @keydown="onKeydown">
      <div class="err">{{ error || '&nbsp;' }}</div>
      <button :disabled="loading" @click="login">{{ loading ? '登录中…' : '进入' }}</button>
    </div>
  </div>
</template>

<style scoped>
.login-page {
  height: 100vh; display: flex; align-items: center; justify-content: center;
  background: var(--bg); color: var(--text);
  font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
}
.card {
  width: 340px; max-width: calc(100vw - 40px);
  background: var(--panel); border: 1px solid var(--border); border-radius: 14px; padding: 28px;
}
h1 { font-size: 17px; margin: 0 0 6px; }
p { font-size: 12px; color: var(--dim); margin: 0 0 18px; }
input {
  width: 100%; box-sizing: border-box; background: var(--bg);
  border: 1px solid var(--border); border-radius: 8px;
  padding: 10px 12px; color: var(--text); font: inherit; outline: none; margin-bottom: 10px;
}
input:focus { border-color: var(--accent); }
.err { color: var(--err); font-size: 12px; margin: 0 0 6px; min-height: 18px; }
button {
  width: 100%; padding: 10px; border: none; border-radius: 8px; cursor: pointer; color: #fff;
  background: linear-gradient(135deg, var(--accent), var(--accent2)); font-size: 14px;
}
button:disabled { opacity: .5; cursor: not-allowed; }
</style>
