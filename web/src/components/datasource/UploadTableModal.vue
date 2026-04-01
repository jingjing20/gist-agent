<template>
  <Teleport to="body">
    <div v-if="modelValue" class="modal-overlay">
      <div class="modal da-modal" :class="{ 'wide-modal': file && isExcel }">
        <button class="modal-close" @click="emit('update:modelValue', null)">
          <i class="fas fa-times"></i>
        </button>
        <h3>上传数据到「{{ modelValue.name }}」</h3>
        
        <div class="da-form">
          <!-- Step 1: Upload Zone -->
          <div
            v-if="!file"
            class="da-upload-zone"
            :class="{ 'is-active': dragOver }"
            @dragover.prevent="dragOver = true"
            @dragleave="dragOver = false"
            @drop.prevent="handleDrop"
            @click="fileInputRef?.click()"
          >
            <input ref="fileInputRef" type="file" accept=".csv,.xlsx,.xls" hidden @change="handleChange" />
            <div class="upload-placeholder">
              <i class="fas fa-cloud-upload-alt"></i>
              <p>点击或拖拽文件到这里</p>
              <span class="support-text">支持 .csv, .xlsx, .xls (单个或多个 Sheet)</span>
            </div>
          </div>

          <!-- Step 2: Table Config List -->
          <div v-else class="file-ready-container">
            <div class="file-summary">
              <div class="file-icon-box">
                <i :class="isExcel ? 'fas fa-file-excel' : 'fas fa-file-csv'"></i>
              </div>
              <div class="file-meta">
                <div class="file-name">{{ file.name }}</div>
                <div class="file-size">{{ (file.size / 1024).toFixed(1) }} KB</div>
              </div>
              <button class="btn-change-file" @click="resetFile">修改文件</button>
            </div>

            <div class="config-section">
              <label class="section-title">确认表名称 ({{ tableConfigs.filter(c => c.selected).length }} / {{ tableConfigs.length }})</label>
              <div class="table-config-list no-scrollbar">
                <div v-for="(config, idx) in tableConfigs" :key="idx" class="table-config-item" :class="{ disabled: !config.selected }">
                  <div class="item-check">
                    <input type="checkbox" v-model="config.selected" :disabled="tableConfigs.length === 1 && config.selected" />
                  </div>
                  <div class="item-sheet-name" v-if="isExcel">
                    <span class="badge">Sheet</span>
                    {{ config.sheetName }}
                  </div>
                  <div class="item-input-group">
                    <i class="fas fa-table"></i>
                    <input v-model="config.displayName" placeholder="输入表展示名" />
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div v-if="error" class="da-error-msg">
            <i class="fas fa-exclamation-circle"></i> {{ error }}
          </div>
        </div>

        <div class="modal-footer">
          <button class="btn-da-ghost" @click="emit('update:modelValue', null)">取消</button>
          <button 
            class="btn-da-primary" 
            :disabled="!file || !canSubmit || submitting" 
            @click="handleSubmit"
          >
            <i class="fas fa-check" v-if="!submitting"></i>
            {{ submitting ? '上传中...' : '开始上传' }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import type { DataSource } from '../../stores/datasource';
import * as XLSX from 'xlsx';

const props = defineProps<{
  modelValue: DataSource | null;
  submitting: boolean;
  error?: string;
}>();

const emit = defineEmits<{
  (e: 'update:modelValue', value: DataSource | null): void;
  (e: 'submit', dsId: number, file: File, configs: { sheetName?: string; displayName: string }[]): void;
}>();

const dragOver = ref(false);
const fileInputRef = ref<HTMLInputElement | null>(null);
const file = ref<File | null>(null);

interface TableConfig {
  sheetName?: string;
  displayName: string;
  selected: boolean;
}
const tableConfigs = ref<TableConfig[]>([]);

const isExcel = computed(() => {
  if (!file.value) return false;
  const ext = file.value.name.split('.').pop()?.toLowerCase();
  return ext === 'xlsx' || ext === 'xls';
});

const canSubmit = computed(() => {
  return tableConfigs.value.some(c => c.selected && c.displayName.trim());
});

watch(() => props.modelValue, (newVal) => {
  if (!newVal) resetFile();
});

function resetFile() {
  file.value = null;
  tableConfigs.value = [];
  if (fileInputRef.value) fileInputRef.value.value = '';
}

async function handleFileSelection(f: File) {
  file.value = f;
  const ext = f.name.split('.').pop()?.toLowerCase();
  
  if (ext === 'xlsx' || ext === 'xls') {
    try {
      const data = await f.arrayBuffer();
      const workbook = XLSX.read(data, { type: 'array' });
      tableConfigs.value = workbook.SheetNames.map(name => ({
        sheetName: name,
        displayName: name, // Default to sheet name
        selected: true
      }));
    } catch (err) {
      console.error('Failed to parse Excel sheets', err);
      // Fallback or error handled by parent/error prop
    }
  } else {
    // CSV
    tableConfigs.value = [{
      displayName: f.name.replace(/\.[^/.]+$/, ""),
      selected: true
    }];
  }
}

function handleChange(e: Event) {
  const files = (e.target as HTMLInputElement).files;
  if (files?.[0]) handleFileSelection(files[0]);
}

function handleDrop(e: DragEvent) {
  dragOver.value = false;
  const files = e.dataTransfer?.files;
  if (files?.[0]) handleFileSelection(files[0]);
}

function handleSubmit() {
  if (!file.value || !canSubmit.value) return;
  const finalConfigs = tableConfigs.value
    .filter(c => c.selected)
    .map(c => ({ sheetName: c.sheetName, displayName: c.displayName.trim() }));
  
  emit('submit', 0, file.value, finalConfigs);
}
</script>

<style scoped>
/* modal-overlay and modal defaults are now mostly global */

.modal {
  background: #111827;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 24px;
  padding: 32px;
  width: 480px;
  box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5), 0 0 40px rgba(14, 165, 233, 0.1);
  animation: modal-pop 0.4s cubic-bezier(0.16, 1, 0.3, 1);
  transition: width 0.3s ease;
}

.modal.wide-modal {
  width: 680px;
}

@keyframes modal-pop {
  from { opacity: 0; transform: translateY(20px) scale(0.95); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}

.modal h3 {
  font-size: 20px;
  font-weight: 700;
  color: #fff;
  margin-bottom: 24px;
  margin-top: 0;
  background: linear-gradient(to right, #fff, #94a3b8);
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
}

/* Upload Zone */
.da-upload-zone {
  border: 2px dashed rgba(255, 255, 255, 0.1);
  border-radius: 20px;
  padding: 60px 40px;
  text-align: center;
  cursor: pointer;
  transition: all 0.3s;
  background: rgba(255, 255, 255, 0.02);
}

.da-upload-zone:hover, .da-upload-zone.is-active {
  border-color: #0ea5e9;
  background: rgba(14, 165, 233, 0.05);
  box-shadow: inset 0 0 20px rgba(14, 165, 233, 0.05);
}

.upload-placeholder i {
  font-size: 48px;
  color: #0ea5e9;
  margin-bottom: 20px;
  filter: drop-shadow(0 0 10px rgba(14, 165, 233, 0.3));
}

.upload-placeholder p {
  font-size: 16px;
  font-weight: 600;
  color: #f8fafc;
  margin-bottom: 8px;
}

.support-text {
  font-size: 13px;
  color: #64748b;
}

/* File Ready Container */
.file-ready-container {
  display: flex;
  flex-direction: column;
  gap: 24px;
}

.file-summary {
  display: flex;
  align-items: center;
  padding: 16px;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 16px;
  gap: 16px;
}

.file-icon-box {
  width: 48px;
  height: 48px;
  background: #0ea5e922;
  border-radius: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.file-icon-box i {
  font-size: 24px;
  color: #0ea5e9;
}

.file-meta {
  flex: 1;
}

.file-name {
  font-size: 14px;
  font-weight: 600;
  color: #fff;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 300px;
}

.file-size {
  font-size: 12px;
  color: #64748b;
  margin-top: 2px;
}

.btn-change-file {
  background: transparent;
  color: #0ea5e9;
  border: none;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}

.section-title {
  display: block;
  font-size: 13px;
  font-weight: 600;
  color: #94a3b8;
  margin-bottom: 12px;
}

.table-config-list {
  max-height: 280px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding-right: 4px;
}

.table-config-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px;
  background: rgba(255, 255, 255, 0.02);
  border: 1px solid rgba(255, 255, 255, 0.05);
  border-radius: 12px;
  transition: all 0.2s;
}

.table-config-item:hover {
  background: rgba(255, 255, 255, 0.04);
  border-color: rgba(255, 255, 255, 0.1);
}

.table-config-item.disabled {
  opacity: 0.5;
}

.item-check input {
  width: 18px;
  height: 18px;
  border-radius: 4px;
  cursor: pointer;
}

.item-sheet-name {
  font-size: 13px;
  color: #e2e8f0;
  min-width: 140px;
  display: flex;
  align-items: center;
  gap: 8px;
}

.badge {
  font-size: 10px;
  padding: 2px 6px;
  background: #334155;
  color: #94a3b8;
  border-radius: 4px;
  text-transform: uppercase;
}

.item-input-group {
  flex: 1;
  display: flex;
  align-items: center;
  background: #000;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 8px;
  padding: 6px 12px;
  gap: 10px;
}

.item-input-group i {
  color: #64748b;
  font-size: 14px;
}

.item-input-group input {
  background: transparent;
  border: none;
  color: #fff;
  font-size: 13px;
  width: 100%;
  outline: none;
}

/* Footer & Utils */
.modal-footer {
  display: flex;
  justify-content: flex-end;
  gap: 12px;
  margin-top: 32px;
}

.da-error-msg {
  color: #ef4444;
  font-size: 13px;
  margin-top: 16px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px;
  background: rgba(239, 68, 68, 0.1);
  border-radius: 8px;
}

.btn-da-primary {
  background: #0ea5e9;
  color: #fff;
  border: none;
  padding: 10px 24px;
  border-radius: 12px;
  font-weight: 600;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 8px;
  transition: all 0.2s;
}

.btn-da-primary:hover:not(:disabled) {
  background: #38bdf8;
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(14, 165, 233, 0.3);
}

.btn-da-primary:disabled { opacity: 0.5; cursor: not-allowed; }

.btn-da-ghost {
  background: transparent;
  color: #94a3b8;
  border: 1px solid rgba(255, 255, 255, 0.1);
  padding: 10px 24px;
  border-radius: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s;
}

.btn-da-ghost:hover {
  background: rgba(255, 255, 255, 0.05);
  color: #fff;
}

.no-scrollbar::-webkit-scrollbar { display: none; }
.no-scrollbar { -ms-overflow-style: none; scrollbar-width: none; }
</style>

