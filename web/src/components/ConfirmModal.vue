<template>
  <Teleport to="body">
    <div v-if="modelValue" class="modal-overlay">
      <div class="modal da-modal delete-modal">
        <button class="modal-close" @click="handleCancel">
          <i class="fas fa-times"></i>
        </button>
        <h3 class="modal-title">{{ title }}</h3>
        <p class="modal-desc">{{ desc }}</p>
        <div class="modal-footer">
          <button class="btn btn-ghost" @click="handleCancel">取消</button>
          <button
            class="btn btn-danger"
            @click="handleConfirm"
            :disabled="loading"
          >
            {{ loading ? loadingText || "处理中..." : confirmText || "确认" }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
defineProps<{
  modelValue: boolean;
  title: string;
  desc: string;
  loading?: boolean;
  loadingText?: string;
  confirmText?: string;
}>();

const emit = defineEmits<{
  (e: "update:modelValue", value: boolean): void;
  (e: "confirm"): void;
  (e: "cancel"): void;
}>();

function handleCancel() {
  emit("update:modelValue", false);
  emit("cancel");
}

function handleConfirm() {
  emit("confirm");
}
</script>

<style scoped>
/* modal-overlay is now global in style.css */

.modal {
  background: var(--da-panel);
  border: 1px solid var(--da-border);
  border-radius: 16px;
  padding: 24px 28px;
  width: 400px;
  max-width: 90vw;
  box-shadow: 0 20px 50px rgba(0, 0, 0, 0.5);
  animation: modal-pop 0.25s cubic-bezier(0.34, 1.56, 0.64, 1);
}

@keyframes modal-pop {
  from {
    opacity: 0;
    transform: scale(0.95) translateY(10px);
  }
  to {
    opacity: 1;
    transform: scale(1) translateY(0);
  }
}

.modal-title {
  font-size: 18px;
  font-weight: 700;
  color: #fff;
  margin-bottom: 12px;
  margin-top: 0;
}

.modal-desc {
  font-size: 14px;
  color: var(--da-text-muted);
  line-height: 1.6;
  margin-bottom: 24px;
}

.modal-footer {
  display: flex;
  justify-content: flex-end;
  gap: 12px;
}

.btn {
  font-size: 14px;
  font-weight: 600;
  padding: 10px 20px;
  border-radius: 10px;
  border: none;
  cursor: pointer;
  transition: all 0.2s;
  font-family: inherit;
}

.btn-ghost {
  background: var(--da-card);
  color: var(--da-text-main);
  border: 1px solid var(--da-border);
}

.btn-ghost:hover {
  background: var(--da-border);
  color: #fff;
}

.btn-danger {
  background: #ef4444;
  color: white;
  box-shadow: 0 4px 12px rgba(239, 68, 68, 0.2);
}

.btn-danger:hover:not(:disabled) {
  background: #dc2626;
  transform: translateY(-1px);
}

.btn-danger:disabled {
  opacity: 0.5;
  cursor: not-allowed;
  transform: none;
}
</style>
