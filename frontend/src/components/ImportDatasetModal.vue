<script setup lang="ts">
/**
 * 数据集导入弹窗（三步式，决定用户上传成功率的关键交互）：
 * 1. 选文件（附模板下载）→ 2. 列映射确认（自动猜 + 手调 + 预览 + 校验）→ 3. 命名导入
 * 错误在映射页就暴露，行级错误给出前 N 条；警告放行但黄字提示。
 */
import { computed, ref } from 'vue';

const props = defineProps<{ open: boolean; existingNames?: string[] }>();
const emit = defineEmits<{ (e: 'close'): void; (e: 'imported', name: string): void }>();

const step = ref<1 | 2 | 3>(1);
const file = ref<File | null>(null);
const parsing = ref(false);
const importing = ref(false);
const errorMsg = ref('');

// 预览结果
const headers = ref<string[]>([]);
const mapping = ref<Record<string, number | undefined>>({});
const sample = ref<string[][]>([]);
const rowCount = ref(0);
const warnings = ref<string[]>([]);
const errors = ref<string[]>([]);

const FIELDS = [
  { key: 'chapterId', label: '章节序号', required: true },
  { key: 'title', label: '章节标题', required: true },
  { key: 'readers', label: '阅读人数', required: true },
  { key: 'finishRate', label: '完读率', required: true },
  { key: 'netFollow', label: '净增追更', required: false },
  { key: 'publishedAt', label: '发布日期', required: false },
  { key: 'wordCount', label: '字数', required: false },
] as const;

const name = ref('');
const canImport = computed(() => FIELDS.every((f) => !f.required || mapping.value[f.key] !== undefined) && !!file.value);

/** 模板下载：客户端生成，零后端依赖 */
function downloadTemplate() {
  const csv = [
    '章节,标题,阅读人数,完读率,净增追更,发布日期,字数',
    '1,第一章 雪夜来客,52000,0.92,1200,2026-09-01,3200',
    '2,第二章 旧宅疑云,48100,0.89,980,2026-09-03,3500',
    '3,第三章 地窖,45300,0.71,410,2026-09-05,2900',
  ].join('\n');
  const url = URL.createObjectURL(new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = '阅读数据模板.csv';
  a.click();
  URL.revokeObjectURL(url);
}

function onFileChange(e: Event) {
  file.value = (e.target as HTMLInputElement).files?.[0] ?? null;
  if (file.value) name.value = file.value.name.replace(/\.csv$/i, '');
  step.value = 1;
}

/** 第 1 → 2 步：上传预览（服务端解析 + 自动映射 + 校验，不落库） */
async function toMapping() {
  if (!file.value) return;
  parsing.value = true;
  errorMsg.value = '';
  try {
    const fd = new FormData();
    fd.append('file', file.value);
    const res = await fetch('/api/datasets/preview', { method: 'POST', body: fd });
    const data = await res.json();
    if (!res.ok) {
      errorMsg.value = data.error || '解析失败';
      return;
    }
    headers.value = data.headers;
    mapping.value = data.mapping;
    sample.value = data.sample;
    rowCount.value = data.rowCount;
    warnings.value = data.warnings;
    errors.value = data.errors;
    step.value = 2;
  } catch {
    errorMsg.value = '网络异常，请重试';
  } finally {
    parsing.value = false;
  }
}

/** 第 2 → 3 步：确认映射正式导入 */
async function doImport() {
  if (!file.value || !name.value.trim()) return;
  importing.value = true;
  errorMsg.value = '';
  try {
    const fd = new FormData();
    fd.append('file', file.value);
    fd.append('name', name.value.trim());
    fd.append('mapping', JSON.stringify(mapping.value));
    const res = await fetch('/api/datasets', { method: 'POST', body: fd });
    const data = await res.json();
    if (!res.ok) {
      errorMsg.value = data.error || '导入失败';
      if (data.errors?.length) errors.value = data.errors;
      return;
    }
    warnings.value = data.warnings ?? [];
    step.value = 3;
    emit('imported', data.name);
  } catch {
    errorMsg.value = '网络异常，请重试';
  } finally {
    importing.value = false;
  }
}
</script>

<template>
  <div v-if="open" class="mask" @click.self="emit('close')">
    <div class="modal">
      <div class="m-head">
        <span>导入阅读数据</span>
        <span class="steps-ind">① 选文件 → ② 列映射 → ③ 完成</span>
        <button class="close" @click="emit('close')">✕</button>
      </div>

      <!-- 步骤 1：选文件 -->
      <div v-if="step === 1" class="m-body">
        <input type="file" accept=".csv,.xlsx,text/csv" @change="onFileChange" />
        <button class="tpl" @click="downloadTemplate">⬇ 下载 CSV 模板</button>
        <div class="fmt-tip">
          支持 CSV（UTF-8/GBK）或 Excel (.xlsx)，一行一章，≤ 2000 行。
          必填列：<b>章节序号、章节标题、阅读人数、完读率</b>；可选：净增追更、字数、评论数、差评率、收入（有哪列分析哪个维度）。
          列名不必一致，下一步可手动映射。
        </div>
        <div class="fmt-tip update-tip">💡 名称与现有数据集相同 = <b>增量更新</b>该数据集（按章节序号合并，不新建）</div>
        <div v-if="errorMsg" class="err">{{ errorMsg }}</div>
        <button class="primary" :disabled="!file || parsing" @click="toMapping">{{ parsing ? '解析中…' : '解析并预览 →' }}</button>
      </div>

      <!-- 步骤 2：列映射 + 命名 -->
      <div v-else-if="step === 2" class="m-body">
        <div class="name-row">
          <span class="f-label">数据集名称</span>
          <input v-model="name" list="ds-names" placeholder="默认取文件名" />
          <datalist id="ds-names">
            <option v-for="n in existingNames ?? []" :key="n" :value="n" />
          </datalist>
        </div>
        <div class="map-grid">
          <div v-for="f in FIELDS" :key="f.key" class="map-row">
            <span class="f-label">{{ f.label }}<i v-if="f.required" class="req">*</i></span>
            <select v-model="mapping[f.key]" :class="{ unset: mapping[f.key] === undefined }">
              <option :value="undefined">（未映射）</option>
              <option v-for="(h, i) in headers" :key="i" :value="i">{{ h }}</option>
            </select>
          </div>
        </div>

        <div class="preview-label">数据预览（前 {{ sample.length }} 行）</div>
        <div class="table-wrap">
          <table>
            <thead><tr><th v-for="(h, i) in headers" :key="i">{{ h }}</th></tr></thead>
            <tbody>
              <tr v-for="(row, r) in sample" :key="r">
                <td v-for="(cell, ci) in row" :key="ci">{{ cell }}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div v-if="rowCount" class="ok-line">共识别 {{ rowCount }} 行数据</div>
        <div v-for="w in warnings" :key="w" class="warn">⚠ {{ w }}</div>
        <div v-for="e in errors" :key="e" class="err">✕ {{ e }}</div>
        <div v-if="errorMsg" class="err">{{ errorMsg }}</div>

        <div class="m-actions">
          <button class="ghost" @click="step = 1">← 上一步</button>
          <button class="primary" :disabled="!canImport || importing || errors.length > 0" @click="doImport">
            {{ importing ? '导入中…' : errors.length ? '修正错误后重试' : '确认导入' }}
          </button>
        </div>
      </div>

      <!-- 步骤 3：完成 -->
      <div v-else class="m-body">
        <div class="done">✅ 导入成功</div>
        <div v-for="w in warnings" :key="w" class="warn">⚠ {{ w }}</div>
        <div class="fmt-tip">数据集已出现在左侧列表，选中即可「生成分析报告」。若同名小说已上传知识库，报告还会附带原文情节归因。</div>
        <button class="primary" @click="emit('close')">完成</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.mask { position: fixed; inset: 0; background: rgba(0,0,0,.45); display: flex; align-items: center; justify-content: center; z-index: 60; }
.modal {
  width: 560px; max-width: 92vw; max-height: 86vh; overflow-y: auto;
  background: var(--panel); border: 1px solid var(--border); border-radius: 14px; padding: 18px 20px;
}
.m-head { display: flex; align-items: center; gap: 10px; font-weight: 600; }
.steps-ind { font-size: 12px; color: var(--dim); font-weight: 400; flex: 1; }
.close { border: none; background: none; cursor: pointer; color: var(--dim); }
.m-body { margin-top: 14px; display: flex; flex-direction: column; gap: 10px; }
input[type='file'] { font-size: 13px; }
.tpl { align-self: flex-start; border: 1px solid var(--border); background: var(--panel2); border-radius: 7px; padding: 5px 10px; font-size: 12px; cursor: pointer; color: var(--dim); }
.fmt-tip { font-size: 12px; color: var(--dim); line-height: 1.6; }
.update-tip { color: var(--accent2); background: rgba(139,108,255,.07); border-radius: 6px; padding: 6px 8px; }
.name-row { display: flex; align-items: center; gap: 10px; }
.name-row input {
  flex: 1; padding: 7px 10px; border: 1px solid var(--border); border-radius: 7px;
  background: var(--panel2); color: var(--text); font-size: 13px; outline: none;
}
.name-row input:focus { border-color: var(--accent2); }
.map-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 14px; }
.map-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.f-label { font-size: 13px; }
.req { color: var(--err); font-style: normal; margin-left: 2px; }
.map-row select { flex: 1; max-width: 150px; padding: 4px 6px; border: 1px solid var(--border); border-radius: 6px; background: var(--panel2); color: var(--text); font-size: 12px; }
.map-row select.unset { color: var(--dim); border-style: dashed; }
.preview-label { font-size: 12px; color: var(--dim); }
.table-wrap { max-height: 180px; overflow: auto; border: 1px solid var(--border); border-radius: 8px; }
table { width: 100%; border-collapse: collapse; font-size: 12px; }
th, td { padding: 5px 8px; border-bottom: 1px solid var(--border); text-align: left; white-space: nowrap; }
th { background: var(--panel2); position: sticky; top: 0; }
.ok-line { font-size: 12px; color: #389e0d; }
.warn { font-size: 12px; color: #d48806; background: rgba(212,136,6,.08); border-radius: 6px; padding: 5px 8px; }
.err { font-size: 12px; color: var(--err); background: rgba(248,113,113,.08); border-radius: 6px; padding: 5px 8px; }
.done { font-size: 15px; font-weight: 600; color: #389e0d; }
.m-actions { display: flex; justify-content: space-between; margin-top: 4px; }
.primary {
  border: none; border-radius: 8px; padding: 9px 18px; cursor: pointer; font-size: 13px;
  background: linear-gradient(135deg, var(--accent), var(--accent2)); color: #fff;
}
.primary:disabled { opacity: .45; cursor: not-allowed; }
.ghost { border: 1px solid var(--border); background: transparent; border-radius: 8px; padding: 9px 14px; font-size: 13px; cursor: pointer; color: var(--dim); }
</style>
