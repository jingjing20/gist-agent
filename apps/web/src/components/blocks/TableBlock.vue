<template>
    <div class="table-block">
        <div class="table-header">
            <div class="header-left">
                <i class="fas fa-table text-da-primary"></i>
                <span class="table-label">{{ title || '查询结果预览' }}</span>
            </div>
            <div class="header-right">
                <span class="row-count"> 已返回 {{ rowCount ?? rows?.length ?? 0 }} 条记录<span v-if="isLimited">（查询结果受限，可能还有更多）</span> </span>
                <div class="table-actions">
                    <Button v-if="rows && rows.length > 0" variant="ghost" size="icon-sm" aria-label="导出数据" title="导出数据" @click="exportToExcel"
                        ><Download data-icon="inline-start"
                    /></Button>
                    <slot name="actions" />
                </div>
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
        <div v-if="rows && rows.length > maxDisplay" class="table-footer">仅展示前 {{ maxDisplay }} 条，当前返回的全部数据可导出或进一步分析</div>
    </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { Download } from '@lucide/vue';
import { Button } from '../ui/button';

const props = withDefaults(
    defineProps<{
        title?: string;
        columns?: string[];
        rows?: Record<string, unknown>[];
        rowCount?: number;
        isLimited?: boolean;
        maxDisplay?: number;
    }>(),
    { maxDisplay: 200 }
);

const displayRows = computed(() => {
    return (props.rows || []).slice(0, props.maxDisplay);
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
        const values = header.map((col) => {
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
    display: flex;
    flex-direction: column;
    max-height: 420px;
    background: var(--da-panel);
    box-shadow: 0 4px 20px color-mix(in srgb, var(--shadow-color) 20%, transparent);
}

.table-header {
    flex-shrink: 0;
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 12px 16px;
    background: color-mix(in srgb, var(--foreground) 2%, transparent);
    border-bottom: 1px solid var(--da-border);
}

.header-left {
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 8px;
}

.table-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 13px;
    font-weight: 600;
    color: var(--da-text-main);
}

.header-right {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 12px;
}

.table-actions {
    display: flex;
    align-items: center;
    gap: 2px;
    opacity: 0;
    pointer-events: none;
    transition: opacity 150ms ease;
}
.table-block:hover .table-actions,
.table-block:focus-within .table-actions {
    opacity: 1;
    pointer-events: auto;
}
@media (hover: none) {
    .table-actions {
        opacity: 1;
        pointer-events: auto;
    }
}
@media (prefers-reduced-motion: reduce) {
    .table-actions {
        transition: none;
    }
}
.row-count {
    font-size: 11px;
    color: var(--da-text-muted);
    background: color-mix(in srgb, var(--foreground) 5%, transparent);
    padding: 2px 8px;
    border-radius: 10px;
}

.table-wrapper {
    overflow-x: auto;
    max-height: 420px;
    min-height: 0;
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
    background: var(--bg-code-header); /* Slate-800 like header */
    padding: 10px 16px;
    text-align: left;
    font-weight: 600;
    color: var(--da-text-muted);
    white-space: nowrap;
    border-bottom: 1px solid var(--da-border);
}

td {
    padding: 10px 16px;
    border-bottom: 1px solid color-mix(in srgb, var(--foreground) 3%, transparent);
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
    background: color-mix(in srgb, var(--status-info) 5%, transparent);
}

tbody tr:last-child td {
    border-bottom: none;
}

.table-footer {
    flex-shrink: 0;
    padding: 10px 16px;
    font-size: 12px;
    color: var(--da-text-muted);
    text-align: center;
    border-top: 1px solid var(--da-border);
    background: color-mix(in srgb, var(--foreground) 1%, transparent);
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
