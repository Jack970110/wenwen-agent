<script setup lang="ts">
import { ref, watch } from 'vue';

const props = defineProps<{ disabled?: boolean; deep?: boolean }>();
const emit = defineEmits<{
  (e: 'send', text: string): void;
  (e: 'stop'): void;
  (e: 'toggle-deep'): void;
}>();

const input = ref('');
const el = ref<HTMLTextAreaElement>();

function doSend() {
  const text = input.value.trim();
  if (!text || props.disabled) return;
  emit('send', text);
  input.value = '';
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    doSend();
  }
}

// 快捷问题自动填充
defineExpose({ setText: (t: string) => { input.value = t; el.value?.focus(); } });

watch(input, () => {
  if (!el.value) return;
  el.value.style.height = 'auto';
  el.value.style.height = Math.min(el.value.scrollHeight, 120) + 'px';
});
</script>

<template>
  <footer>
    <div class="input-wrap">
      <textarea
        ref="el"
        v-model="input"
        rows="1"
        placeholder="输入问题，Enter 发送，Shift+Enter 换行"
        :disabled="disabled"
        @keydown="onKeydown"
      ></textarea>
      <div class="actions">
        <button
          class="deep-toggle"
          :class="{ on: deep }"
          :title="deep ? '深度思考已开启（Z1 推理模型，较慢）' : '开启深度思考（Z1 推理模型，较慢）'"
          @click="emit('toggle-deep')"
        >💡{{ deep ? '深度思考·开' : '深度思考' }}</button>
        <button v-if="!disabled" class="send" @click="doSend">发送</button>
        <button v-else class="stop" @click="emit('stop')">停止</button>
      </div>
    </div>
    <div class="hint">AI 生成内容仅供参考 · 请勿输入敏感信息</div>
  </footer>
</template>

<style scoped>
footer { padding: 14px 20px 18px; }
.input-wrap {
  max-width: 780px; margin: 0 auto; display: flex; gap: 10px; align-items: flex-end;
  background: var(--panel); border: 1px solid var(--border); border-radius: 12px; padding: 10px;
  transition: border-color .15s;
}
.input-wrap:focus-within { border-color: var(--accent); }
textarea {
  flex: 1; background: transparent; border: none; outline: none; resize: none;
  color: var(--text); font: inherit; line-height: 1.5; max-height: 120px;
}
textarea::placeholder { color: var(--dim); }
.send, .stop, .deep-toggle {
  border: none; border-radius: 8px; padding: 8px 14px; cursor: pointer;
  font-size: 13px; color: #fff; flex-shrink: 0;
}
.send { background: linear-gradient(135deg, var(--accent), var(--accent2)); }
.send:disabled { opacity: .4; cursor: not-allowed; }
.stop { background: transparent; border: 1px solid var(--err); color: var(--err); }
.deep-toggle { background: var(--panel2); color: var(--dim); border: 1px solid var(--border); }
.deep-toggle.on { background: rgba(139,108,255,.15); color: var(--accent2); border-color: var(--accent2); }
.hint { max-width: 780px; margin: 8px auto 0; text-align: center; color: var(--dim); font-size: 12px; }
</style>
