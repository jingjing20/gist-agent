<template>
  <div class="ds-card">
    <div class="card-gradient" :class="ds.is_local ? 'local' : 'file'"></div>

    <div class="card-body">
      <div class="ds-type-label">
        <i :class="ds.is_local ? 'fas fa-database' : 'fas fa-file-csv'"></i>
        {{ ds.is_local ? "公共数据库" : "文件数据源" }}
      </div>

      <h3 class="ds-name-title" :title="ds.name">{{ ds.name }}</h3>
      <p class="ds-desc" :title="ds.description || '无描述'">
        {{ ds.description || "通过文件上传创建的数据分析源" }}
      </p>

      <div class="ds-info-rows">
        <div class="info-row">
          <span class="label">最后更新</span>
          <span class="value">{{ formattedDate }}</span>
        </div>
        <div class="info-row">
          <span class="label">所有者</span>
          <span class="value">{{ ownerName }}</span>
        </div>
      </div>
    </div>

    <div class="card-footer">
      <div class="action-buttons">
        <button
          v-if="!ds.is_local && isCreator"
          class="action-btn"
          @click="emit('edit', ds)"
          title="编辑信息"
        >
          <i class="fas fa-edit"></i>
        </button>
        <button
          v-if="!ds.is_local"
          class="action-btn"
          @click="emit('upload', ds)"
          title="上传文件"
        >
          <i class="fas fa-upload"></i>
        </button>
        <button
          v-if="!ds.is_local && isCreator"
          class="action-btn"
          @click="emit('grant', ds)"
          title="授权管理"
        >
          <i class="fas fa-user-shield"></i>
        </button>
        <button
          class="action-btn"
          @click="emit('view-tables', ds)"
          title="查看数据表"
        >
          <i class="fas fa-table"></i>
        </button>
        <button
          v-if="!ds.is_local && isCreator"
          class="action-btn delete"
          @click="emit('delete', ds.id)"
          title="删除数据源"
        >
          <i class="fas fa-trash"></i>
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useAuthStore } from "../../stores/auth";
import type { DataSource } from "../../stores/datasource";

const props = defineProps<{
  ds: DataSource;
}>();

const emit = defineEmits<{
  (e: "upload", ds: DataSource): void;
  (e: "edit", ds: DataSource): void;
  (e: "grant", ds: DataSource): void;
  (e: "view-tables", ds: DataSource): void;
  (e: "delete", id: number): void;
}>();

const authStore = useAuthStore();

const isCreator = computed(() => {
  return props.ds.created_by === authStore.user?.id;
});

const ownerName = computed(() => {
  if (props.ds.is_local) return "System";
  if (isCreator.value) return `${props.ds.creator_name || "我"} (我)`;
  return props.ds.creator_name || "未知用户";
});

const formattedDate = computed(() => {
  const dateStr = props.ds.created_at;
  if (!dateStr) return "-";
  const date = new Date(dateStr);
  return `${date.getMonth() + 1}/${date.getDate()} ${date.getHours()}:${String(date.getMinutes()).padStart(2, "0")}`;
});
</script>

<style scoped>
.ds-card {
  background: var(--da-panel);
  border: 1px solid var(--da-border);
  border-radius: 20px;
  position: relative;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  transition: all 0.2s;
}

.ds-card:hover {
  border-color: var(--da-primary);
  transform: translateY(-4px);
  box-shadow: 0 12px 24px rgba(0, 0, 0, 0.3);
}

.card-gradient {
  height: 4px;
  width: 100%;
}
.card-gradient.local {
  background: linear-gradient(90deg, #8b5cf6, #3b82f6);
}
.card-gradient.file {
  background: linear-gradient(90deg, #0ea5e9, #22d3ee);
}

.card-body {
  padding: 24px;
  flex: 1;
}

.ds-type-label {
  font-size: 11px;
  font-weight: 700;
  color: var(--da-primary);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  margin-bottom: 12px;
  display: flex;
  align-items: center;
  gap: 6px;
}

.ds-name-title {
  font-size: 18px;
  font-weight: 700;
  color: #fff;
  margin: 0 0 8px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.ds-desc {
  font-size: 13px;
  color: var(--da-text-muted);
  line-height: 1.6;
  height: 42px;
  margin-bottom: 24px;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.ds-info-rows {
  border-top: 1px solid rgba(255, 255, 255, 0.05);
  padding-top: 16px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.info-row {
  display: flex;
  justify-content: space-between;
  font-size: 12px;
}

.info-row .label {
  color: var(--da-text-muted);
}
.info-row .value {
  color: var(--da-text-main);
  font-weight: 500;
}

.card-footer {
  padding: 16px 24px;
  background: rgba(255, 255, 255, 0.02);
  border-top: 1px solid rgba(255, 255, 255, 0.05);
}

.action-buttons {
  display: flex;
  gap: 8px;
}

.action-btn {
  width: 36px;
  height: 36px;
  background: var(--da-card);
  border: 1px solid var(--da-border);
  border-radius: 8px;
  color: var(--da-text-muted);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.2s;
}

.action-btn:hover {
  background: var(--da-border);
  color: #fff;
  border-color: var(--da-primary);
}

.action-btn.delete:hover {
  background: rgba(239, 68, 68, 0.1);
  color: #ef4444;
  border-color: #ef4444;
}
</style>
