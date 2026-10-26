<script setup lang="ts">
import { ref, watch } from 'vue';
import { useNovelStore } from '../stores/novels';

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ (e: 'close'): void }>();

const store = useNovelStore();
const title = ref('');
const file = ref<File | null>(null);
const fileEl = ref<HTMLInputElement>();

// 每次打开重置表单
watch(() => props.open, (v) => {
  if (v) {
    title.value = '';
    file.value = null;
    store.uploadMsg = '';
    store.uploadError = '';
  }
});

function onFileChange(e: Event) {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (!f) return;
  file.value = f;
  // 文件名自动填充标题（去扩展名），可手改
  if (!title.value) title.value = f.name.replace(/\.txt$/i, '');
}

async function doUpload() {
  if (!title.value.trim() || !file.value) return;
  const ok = await store.upload(title.value.trim(), file.value);
  if (ok) setTimeout(() => emit('close'), 1200);
}
</script>

<template>
  <div v-if="open" class="mask" @click.self="emit('close')">
    <div class="modal">
      <div class="head">
        <div class="t">上传小说</div>
        <button class="x" @click="emit('close')">✕</button>
      </div>

      <label class="field">
        <span>小说名</span>
        <input v-model="title" placeholder="如：雪夜来客" :disabled="store.uploading" />
      </label>

      <label class="field">
        <span>txt 文件（≤5MB，需含"第X章"章节标题）</span>
        <div class="file-row" @click="fileEl?.click()">
          <span>{{ file?.name || '选择文件…' }}</span>
          <input ref="fileEl" type="file" accept=".txt" hidden :disabled="store.uploading" @change="onFileChange" />
        </div>
      </label>

      <div v-if="store.uploadMsg" class="msg ok">{{ store.uploadMsg }}</div>
      <div v-if="store.uploadError" class="msg err">{{ store.uploadError }}</div>

      <button class="submit" :disabled="store.uploading || !title.trim() || !file" @click="doUpload">
        {{ store.uploading ? '入库中…' : '开始入库' }}
      </button>
      <div class="tip">入库 = 切块 → 向量化 → 存库，之后就能在对话里问这本小说了</div>
    </div>
  </div>
</template>

<style scoped>
.mask {
  position: fixed; inset: 0; background: rgba(0,0,0,.55); z-index: 50;
  display: flex; align-items: center; justify-content: center;
}
.modal {
  width: 420px; max-width: calc(100vw - 40px); background: var(--panel);
  border: 1px solid var(--border); border-radius: 14px; padding: 20px;
}
.head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }
.t { font-weight: 600; }
.x { background: transparent; border: none; color: var(--dim); cursor: pointer; font-size: 14px; }
.x:hover { color: var(--text); }
.field { display: block; margin-bottom: 14px; }
.field span { display: block; font-size: 12px; color: var(--dim); margin-bottom: 6px; }
.field input, .file-row {
  width: 100%; background: var(--bg); border: 1px solid var(--border); border-radius: 8px;
  padding: 9px 12px; color: var(--text); font: inherit; outline: none;
}
.field input:focus { border-color: var(--accent); }
.file-row { cursor: pointer; color: var(--dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.file-row:hover { border-color: var(--accent); }
.msg { font-size: 13px; padding: 8px 12px; border-radius: 8px; margin-bottom: 12px; }
.msg.ok { background: rgba(74,222,128,.1); color: var(--ok, #4ade80); border: 1px solid rgba(74,222,128,.3); }
.msg.err { background: rgba(248,113,113,.1); color: var(--err); border: 1px solid rgba(248,113,113,.3); }
.submit {
  width: 100%; padding: 10px; border: none; border-radius: 9px; cursor: pointer;
  background: linear-gradient(135deg, var(--accent), var(--accent2)); color: #fff; font-size: 14px;
}
.submit:disabled { opacity: .4; cursor: not-allowed; }
.tip { font-size: 12px; color: var(--dim); text-align: center; margin-top: 10px; }
</style>
