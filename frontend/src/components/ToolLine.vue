<script setup lang="ts">
defineProps<{ name: string; args: string; error?: boolean }>();
</script>

<template>
  <div class="tool-line" :class="{ error }">
    <span class="chip">🔧 <b>{{ name }}</b></span>
    <span class="args">{{ args }}</span>
    <span v-if="error" class="fail">失败</span>
  </div>
</template>

<style scoped>
.tool-line {
  display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--dim);
  max-width: 780px; margin: 0 auto 8px 40px; animation: fadeIn .3s;
}
.chip {
  background: var(--panel2); border: 1px solid var(--border); border-radius: 6px;
  padding: 2px 8px; font-family: ui-monospace, monospace; flex-shrink: 0;
}
.chip b { color: var(--accent); font-weight: 500; }
.error .chip b { color: var(--err); }
.args { font-family: ui-monospace, monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fail { color: var(--err); }
@keyframes fadeIn { from { opacity: 0; transform: translateY(3px); } }
</style>
