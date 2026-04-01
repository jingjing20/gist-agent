<template>
  <Teleport to="body">
    <div v-if="modelValue" class="modal-overlay">
      <div class="modal da-modal table-modal">
        <button class="modal-close" @click="emit('update:modelValue', null)">
          <i class="fas fa-times"></i>
        </button>
        <div class="modal-header">
          <h3>数据表列表: {{ modelValue.name }}</h3>
        </div>
        <div class="modal-scroll-content no-scrollbar">
          <div v-if="loading" class="loading-box">
            <i class="fas fa-circle-notch fa-spin"></i> 加载中...
          </div>
          <div v-else-if="!tables.length" class="empty-box">
            暂无上传的表
          </div>
          <div v-else class="table-grid">
            <div v-for="t in tables" :key="t.id" class="table-list-item">
              <div class="t-info">
                <div class="t-name">
                  {{ t.display_name }}
                  <span class="t-uploader" v-if="t.uploader_name">· 上传者: {{ t.uploader_name }}</span>
                </div>
                <div class="t-code">{{ t.table_name }}</div>
              </div>
              <button
                v-if="!modelValue.is_local && canDelete(modelValue, t)"
                class="t-delete-btn"
                @click="emit('delete-table', modelValue.id, t.id)"
              >
                <i class="fas fa-trash-alt"></i>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import type { DataSource, UploadedTable } from '../../stores/datasource';
import { useAuthStore } from '../../stores/auth';

defineProps<{
  modelValue: DataSource | null;
  tables: UploadedTable[];
  loading: boolean;
}>();

const authStore = useAuthStore();

const canDelete = (ds: DataSource, t: UploadedTable) => {
  const uid = authStore.user?.id;
  if (!uid) return false;
  return ds.created_by === uid || t.user_id === uid;
};

const emit = defineEmits<{
  (e: 'update:modelValue', value: DataSource | null): void;
  (e: 'delete-table', dsId: number, tableId: number): void;
}>();
</script>

<style scoped>
/* modal-overlay is now global in style.css */

.modal {
  background: var(--da-panel);
  border: 1px solid var(--da-border);
  border-radius: 20px;
  padding: 32px;
  box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5);
  animation: modal-pop 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
}

@keyframes modal-pop {
  from { opacity: 0; transform: scale(0.95); }
  to { opacity: 1; transform: scale(1); }
}

.table-modal {
  width: 600px;
  max-height: 80vh;
  display: flex;
  flex-direction: column;
}

.modal-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 24px;
}

.modal-header h3 {
  margin: 0;
  font-size: 20px;
  color: #fff;
}

.close-btn {
  background: none;
  border: none;
  color: var(--da-text-muted);
  font-size: 24px;
  cursor: pointer;
}

.modal-scroll-content {
  flex: 1;
  overflow-y: auto;
}

.loading-box, .empty-box {
  padding: 40px;
  text-align: center;
  color: var(--da-text-muted);
}

.table-grid {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.table-list-item {
  background: var(--da-card);
  border: 1px solid var(--da-border);
  border-radius: 12px;
  padding: 12px 16px;
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.t-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.t-name { font-weight: 600; color: #fff; font-size: 14px; display: flex; align-items: center; }
.t-uploader { font-size: 11px; font-weight: 400; color: var(--da-text-muted); margin-left: 8px; }
.t-code { font-size: 12px; color: var(--da-text-muted); font-family: monospace; }

.t-delete-btn {
  background: none;
  border: none;
  color: var(--da-text-muted);
  cursor: pointer;
  transition: color 0.2s;
}
.t-delete-btn:hover { color: #ef4444; }

.no-scrollbar::-webkit-scrollbar { display: none; }
.no-scrollbar { -ms-overflow-style: none; scrollbar-width: none; }
</style>
