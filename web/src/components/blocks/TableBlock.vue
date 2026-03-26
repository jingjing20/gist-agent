<template>
  <div class="table-block">
    <div class="table-header">
      <div class="header-left">
        <i class="fas fa-table text-da-primary"></i>
        <span class="table-label">查询结果预览</span>
      </div>
      <span class="row-count">共 {{ rowCount || rows?.length || 0 }} 条记录</span>
    </div>
    <div class="table-wrapper no-scrollbar">
      <table>
        <thead>
          <tr>
            <th v-for="col in columns" :key="col">{{ col }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(row, i) in displayRows" :key="i">
            <td v-for="col in columns" :key="col" :title="String(row[col])">
              {{ formatCell(row[col]) }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <div v-if="rows && rows.length > MAX_DISPLAY" class="table-footer">
      仅展示前 {{ MAX_DISPLAY }} 条，完整数据可导出或进一步分析
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';

const MAX_DISPLAY = 50;

const props = defineProps<{
  columns?: string[];
  rows?: Record<string, unknown>[];
  rowCount?: number;
}>();

const displayRows = computed(() => {
  return (props.rows || []).slice(0, MAX_DISPLAY);
});

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return '-';
  if (typeof value === 'number') {
    return Number.isInteger(value) ? value.toLocaleString() : value.toFixed(2);
  }
  return String(value);
}
</script>

<style scoped>
.table-block {
  border-radius: 12px;
  border: 1px solid var(--da-border);
  overflow: hidden;
  background: var(--da-panel);
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.2);
}

.table-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 16px;
  background: rgba(255, 255, 255, 0.02);
  border-bottom: 1px solid var(--da-border);
}

.header-left {
  display: flex;
  align-items: center;
  gap: 8px;
}

.table-label {
  font-size: 13px;
  font-weight: 600;
  color: #fff;
}

.row-count {
  font-size: 11px;
  color: var(--da-text-muted);
  background: rgba(255, 255, 255, 0.05);
  padding: 2px 8px;
  border-radius: 10px;
}

.table-wrapper {
  overflow-x: auto;
  max-height: 260px;
  overflow-y: auto;
  position: relative;
}

table {
  width: 100%;
  border-collapse: separate;
  border-spacing: 0;
  font-size: 13px;
}

thead {
  position: sticky;
  top: 0;
  z-index: 10;
}

th {
  background: #1e293b; /* Slate-800 like header */
  padding: 10px 16px;
  text-align: left;
  font-weight: 600;
  color: var(--da-text-muted);
  white-space: nowrap;
  border-bottom: 1px solid var(--da-border);
}

td {
  padding: 10px 16px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.03);
  white-space: nowrap;
  color: var(--da-text-main);
  max-width: 300px;
  overflow: hidden;
  text-overflow: ellipsis;
}

tbody tr {
  transition: background 0.15s;
}

tbody tr:hover {
  background: rgba(14, 165, 233, 0.05);
}

tbody tr:last-child td {
  border-bottom: none;
}

.table-footer {
  padding: 10px 16px;
  font-size: 12px;
  color: var(--da-text-muted);
  text-align: center;
  border-top: 1px solid var(--da-border);
  background: rgba(255, 255, 255, 0.01);
}

.no-scrollbar::-webkit-scrollbar {
  width: 6px;
  height: 6px;
}
.no-scrollbar::-webkit-scrollbar-thumb {
  background: var(--da-border);
  border-radius: 3px;
}
.no-scrollbar::-webkit-scrollbar-track {
  background: transparent;
}
</style>
