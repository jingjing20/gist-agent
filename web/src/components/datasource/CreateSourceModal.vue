<template>
  <Teleport to="body">
    <div v-if="modelValue" class="modal-overlay">
      <div class="modal da-modal">
        <button class="modal-close" @click="emit('update:modelValue', false)">
          <i class="fas fa-times"></i>
        </button>
        <h3>新建数据源</h3>
        <div class="da-form">
          <div class="form-group">
            <label>数据源名称</label>
            <input v-model="form.name" placeholder="请输入数据源名称" />
          </div>
          <div class="form-group">
            <label>描 述</label>
            <textarea
              v-model="form.description"
              placeholder="请输入数据源描述（可选）"
              rows="3"
            ></textarea>
          </div>
          <div v-if="error" class="da-error-msg">{{ error }}</div>
        </div>
        <div class="modal-footer">
          <button
            class="btn-da-ghost"
            @click="emit('update:modelValue', false)"
          >
            取消
          </button>
          <button
            class="btn-da-primary"
            :disabled="!form.name || submitting"
            @click="handleSubmit"
          >
            {{ submitting ? "创建中..." : "立即创建" }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, reactive, watch } from "vue";

const props = defineProps<{
  modelValue: boolean;
  submitting: boolean;
  error?: string;
}>();

const emit = defineEmits<{
  (e: "update:modelValue", value: boolean): void;
  (e: "submit", form: { name: string; description?: string }): void;
}>();

const form = reactive<{ name: string; description: string }>({
  name: "",
  description: "",
});

watch(
  () => props.modelValue,
  (val) => {
    if (val) {
      form.name = "";
      form.description = "";
    }
  },
);

function handleSubmit() {
  if (form.name) {
    emit("submit", { ...form });
  }
}
</script>

<style scoped>
/* modal-overlay is now global in style.css */

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
  from {
    opacity: 0;
    transform: scale(0.95);
  }
  to {
    opacity: 1;
    transform: scale(1);
  }
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

.form-group input,
.form-group textarea {
  width: 100%;
  background: var(--da-card);
  border: 1px solid var(--da-border);
  border-radius: 10px;
  padding: 10px 14px;
  color: #fff;
  font-size: 14px;
  outline: none;
  transition: all 0.2s;
  font-family: inherit;
  resize: none;
}

.form-group input:focus,
.form-group textarea:focus {
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

.da-upload-zone:hover,
.da-upload-zone.is-active {
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

.upload-placeholder span {
  font-size: 12px;
  color: var(--da-text-muted);
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

.btn-da-primary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

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
