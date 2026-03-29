<template>
  <div class="table-block">
    <div class="table-header">
      <div class="header-left">
        <i class="fas fa-table text-da-primary"></i>
        <span class="table-label">查询结果预览</span>
      </div>
      <div class="header-right">
        <span class="row-count">共 {{ rowCount || rows?.length || 0 }} 条记录</span>
        <button v-if="rows && rows.length > 0" class="export-btn" @click="exportToExcel">
          <i class="fas fa-download"></i> 导出
        </button>
      </div>
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

const MAX_DISPLAY = 200;

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
  
  const strVal = String(value);
  // 处理 ISO 日期字符串 (例如: 2026-02-27T16:00:00.000Z)
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(value)) {
    const date = new Date(value);
    if (!isNaN(date.getTime())) {
      // 如果正好是 00:00:00 (东八区补转后的结果)，则只显示日期
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const day = String(date.getDate()).padStart(2, '0');
      return `${year}-${month}-${day}`;
    }
  }
  
  return strVal;
}

function exportToExcel() {
  if (!props.rows || props.rows.length === 0) return;
  
  const header = props.columns || Object.keys(props.rows[0] || {});
  
  const csvRows = [];
  csvRows.push(header.join(','));
  
  for (const row of props.rows) {
    const values = header.map(col => {
      let val = row[col];
      if (val === null || val === undefined) val = '';
      const strVal = String(val);
      if (strVal.includes(',') || strVal.includes('"') || strVal.includes('\n')) {
        return `"${strVal.replace(/"/g, '""')}"`;
      }
      return strVal;
    });
    csvRows.push(values.join(','));
  }
  
  const csvContent = '\uFEFF' + csvRows.join('\n');
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.setAttribute('href', url);
  link.setAttribute('download', `data_export_${new Date().getTime()}.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
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

.header-right {
  display: flex;
  align-items: center;
  gap: 12px;
}

.export-btn {
  background: rgba(14, 165, 233, 0.1);
  color: #38bdf8;
  border: 1px solid rgba(14, 165, 233, 0.2);
  padding: 4px 10px;
  border-radius: 6px;
  font-size: 12px;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 4px;
  transition: all 0.2s;
}

.export-btn:hover {
  background: rgba(14, 165, 233, 0.2);
  border-color: rgba(14, 165, 233, 0.4);
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
