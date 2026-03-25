<template>
  <Teleport to="body">
    <div v-if="modelValue" class="modal-overlay" @click.self="emit('update:modelValue', null)">
      <div class="modal da-modal">
        <h3>上传数据到「{{ modelValue.name }}」</h3>
        <div class="da-form">
          <div class="form-group">
            <label>数据表名称</label>
            <input v-model="displayName" placeholder="例如：2024Q3 财务数据" />
          </div>
          <div
            class="da-upload-zone"
            :class="{ 'is-active': dragOver || file }"
            @dragover.prevent="dragOver = true"
            @dragleave="dragOver = false"
            @drop.prevent="handleDrop"
            @click="fileInputRef?.click()"
          >
            <input ref="fileInputRef" type="file" accept=".csv,.xlsx,.xls" hidden @change="handleChange" />
            <div v-if="file" class="file-info">
              <i class="fas fa-file-csv"></i>
              <div class="name">{{ file.name }}</div>
              <div class="size">{{ (file.size / 1024).toFixed(1) }} KB</div>
            </div>
            <div v-else class="upload-placeholder">
              <i class="fas fa-plus"></i>
              <p>点击或拖拽文件</p>
            </div>
          </div>
          <div v-if="error" class="da-error-msg">{{ error }}</div>
        </div>
        <div class="modal-footer">
          <button class="btn-da-ghost" @click="emit('update:modelValue', null)">取消</button>
          <button class="btn-da-primary" :disabled="!file || !displayName || submitting" @click="handleSubmit">
            {{ submitting ? '上传中...' : '确认上传' }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import type { DataSource } from '../../stores/datasource';

defineProps<{
  modelValue: DataSource | null;
  submitting: boolean;
  error?: string;
}>();

const emit = defineEmits<{
  (e: 'update:modelValue', value: DataSource | null): void;
  (e: 'submit', dsId: number, file: File, displayName: string): void;
}>();

const dragOver = ref(false);
const fileInputRef = ref<HTMLInputElement | null>(null);
const file = ref<File | null>(null);
const displayName = ref('');

function handleFileSelection(f: File) {
  file.value = f;
  if (!displayName.value) {
    displayName.value = f.name.replace(/\.[^/.]+$/, "");
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
  if (file.value && displayName.value) {
    emit('submit', 0, file.value, displayName.value); // dsId is handled by parent via modelValue
  }
}
</script>

<style scoped>
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.7);
  backdrop-filter: blur(8px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 9999;
}

.modal {
  background: var(--da-panel);
  border: 1px solid var(--da-border);
  border-radius: 20px;
  padding: 32px;
  width: 500px;
  box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5);
  animation: modal-pop 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
}

@keyframes modal-pop {
  from { opacity: 0; transform: scale(0.95); }
  to { opacity: 1; transform: scale(1); }
}

.modal h3 {
  font-size: 20px;
  font-weight: 700;
  color: #fff;
  margin-bottom: 24px;
  margin-top: 0;
}

.form-group {
  margin-bottom: 20px;
}

.form-group label {
  display: block;
  font-size: 13px;
  font-weight: 600;
  color: var(--da-text-muted);
  margin-bottom: 8px;
}

.form-group input {
  width: 100%;
  background: var(--da-card);
  border: 1px solid var(--da-border);
  border-radius: 10px;
  padding: 10px 14px;
  color: #fff;
  font-size: 14px;
  outline: none;
  transition: all 0.2s;
}

.form-group input:focus {
  border-color: var(--da-primary);
  background: rgba(14, 165, 233, 0.05);
}

.da-upload-zone {
  border: 2px dashed var(--da-border);
  border-radius: 12px;
  padding: 40px 24px;
  text-align: center;
  cursor: pointer;
  transition: all 0.2s;
  background: rgba(255, 255, 255, 0.02);
}

.da-upload-zone:hover, .da-upload-zone.is-active {
  border-color: var(--da-primary);
  background: rgba(14, 165, 233, 0.05);
}

.upload-placeholder i {
  font-size: 32px;
  color: var(--da-text-muted);
  margin-bottom: 12px;
}

.upload-placeholder p {
  font-size: 14px;
  color: var(--da-text-main);
  margin-bottom: 4px;
}

.file-info {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
}

.file-info i {
  font-size: 32px;
  color: var(--da-primary);
}

.file-info .name {
  font-size: 14px;
  font-weight: 600;
  color: #fff;
}

.file-info .size {
  font-size: 12px;
  color: var(--da-text-muted);
}

.da-error-msg {
  color: #ef4444;
  font-size: 12px;
  margin-top: 12px;
}

.modal-footer {
  display: flex;
  justify-content: flex-end;
  gap: 12px;
  margin-top: 32px;
}

.btn-da-primary {
  background: var(--da-primary);
  color: #fff;
  border: none;
  padding: 10px 24px;
  border-radius: 10px;
  font-weight: 600;
  cursor: pointer;
}

.btn-da-primary:disabled { opacity: 0.5; cursor: not-allowed; }

.btn-da-ghost {
  background: var(--da-card);
  color: var(--da-text-main);
  border: 1px solid var(--da-border);
  padding: 10px 24px;
  border-radius: 10px;
  font-weight: 600;
  cursor: pointer;
}
</style>
