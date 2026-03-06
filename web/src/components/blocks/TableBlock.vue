<template>
  <div class="table-block">
    <div class="table-header">
      <span class="table-label">查询结果</span>
      <span class="row-count">共 {{ rowCount }} 条</span>
    </div>
    <div class="table-wrapper">
      <table>
        <thead>
          <tr>
            <th v-for="col in columns" :key="col">{{ col }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(row, i) in displayRows" :key="i">
            <td v-for="col in columns" :key="col">{{ formatCell(row[col]) }}</td>
          </tr>
        </tbody>
      </table>
    </div>
    <div v-if="rows && rows.length > MAX_DISPLAY" class="table-footer">
      仅展示前 {{ MAX_DISPLAY }} 条，共 {{ rows.length }} 条
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
  margin: 8px 0;
  border-radius: 8px;
  border: 1px solid var(--border);
  overflow: hidden;
}

.table-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 14px;
  background: var(--bg-code-header);
  border-bottom: 1px solid var(--border);
}

.table-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--accent);
}

.row-count {
  font-size: 12px;
  color: var(--text-secondary);
}

.table-wrapper {
  overflow-x: auto;
  max-height: 400px;
  overflow-y: auto;
}

table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}

thead {
  position: sticky;
  top: 0;
  z-index: 1;
}

th {
  background: var(--bg-secondary);
  padding: 8px 14px;
  text-align: left;
  font-weight: 600;
  color: var(--text-secondary);
  white-space: nowrap;
  border-bottom: 1px solid var(--border);
}

td {
  padding: 7px 14px;
  border-bottom: 1px solid var(--border-light);
  white-space: nowrap;
  color: var(--text-primary);
}

tbody tr:hover {
  background: var(--bg-hover);
}

.table-footer {
  padding: 8px 14px;
  font-size: 12px;
  color: var(--text-secondary);
  text-align: center;
  border-top: 1px solid var(--border);
  background: var(--bg-code-header);
}
</style>
