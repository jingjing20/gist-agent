<template>
    <section class="artifact-table">
        <div class="table-heading">
            <strong>{{ title || metadata?.title || '查询结果' }}</strong>
            <div class="heading-right">
                <span v-if="metadata">{{ metadata.returnedRowCount }} 行</span><slot name="actions" />
            </div>
        </div>
        <p v-if="metadata?.isLimited" class="table-warning">查询结果有截断，仅展示已返回的数据。</p>
        <p v-for="(warning, index) in metadata?.quality?.warnings" :key="index" class="table-warning">{{ warning.message }} {{ warning.action }}</p>
        <p v-if="error" role="alert">{{ error }} <button type="button" @click="load(true)">重试</button></p>
        <p v-else-if="!metadata">正在读取表格…</p>
        <template v-else>
            <div class="table-scroll">
                <table>
                    <thead>
                        <tr>
                            <th v-for="column in metadata.columns" :key="column.name" scope="col">{{ column.name }}</th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr v-for="(row, index) in rows" :key="index">
                            <td v-for="column in metadata.columns" :key="column.name">{{ formatCell(row[column.name]) }}</td>
                        </tr>
                    </tbody>
                </table>
            </div>
            <p v-if="!rows.length" class="empty">查询没有返回记录。</p>
            <div v-if="nextCursor" class="table-footer">
                <span>已显示 {{ rows.length }} / {{ metadata.returnedRowCount }} 行</span>
                <button type="button" :disabled="loading" @click="load(false)">{{ loading ? '正在读取…' : '加载更多' }}</button>
            </div>
        </template>
    </section>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue';
import { apiFetch } from '../../api';

const props = defineProps<{ artifactId: string; conversationId: string; title?: string }>();
interface Metadata {
    title: string;
    columns: Array<{ name: string }>;
    returnedRowCount: number;
    isLimited: boolean;
    quality?: { warnings: Array<{ message: string; action?: string }> };
}
const metadata = ref<Metadata>();
const rows = ref<Record<string, unknown>[]>([]);
const nextCursor = ref<string | null>(null);
const loading = ref(false);
const error = ref('');
let revision = 0;

async function fetchJson(url: string) {
    const response = await apiFetch(url);
    if (!response.ok) throw new Error((await response.json().catch(() => ({}))).message || '读取表格失败');
    return response.json();
}

async function load(reset: boolean) {
    if (loading.value) return;
    const current = reset ? ++revision : revision;
    if (reset) {
        metadata.value = undefined;
        rows.value = [];
        nextCursor.value = null;
    }
    loading.value = true;
    error.value = '';
    try {
        const base = `/analysis-artifacts/${encodeURIComponent(props.artifactId)}`;
        const query = `conversationId=${encodeURIComponent(props.conversationId)}`;
        if (reset) {
            const nextMetadata: Metadata = await fetchJson(`${base}?${query}`);
            if (current !== revision) return;
            metadata.value = nextMetadata;
        }
        const cursor = reset ? '' : `&cursor=${encodeURIComponent(nextCursor.value || '')}`;
        const page: { rows: Record<string, unknown>[]; nextCursor: string | null } = await fetchJson(`${base}/rows?${query}&limit=100${cursor}`);
        if (current !== revision) return;
        rows.value = reset ? page.rows : [...rows.value, ...page.rows];
        nextCursor.value = page.nextCursor;
    } catch (cause) {
        if (current === revision) error.value = cause instanceof Error ? cause.message : '读取表格失败';
    } finally {
        if (current === revision) loading.value = false;
    }
}

function formatCell(value: unknown) {
    if (value === null || value === undefined) return '—';
    return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

watch(
    () => [props.artifactId, props.conversationId],
    () => {
        revision++;
        loading.value = false;
        void load(true);
    },
    { immediate: true }
);
</script>

<style scoped>
.artifact-table {
    border: 1px solid var(--da-border);
    border-radius: 12px;
    background: var(--da-panel);
    overflow: hidden;
    display: flex;
    flex-direction: column;
    max-height: 420px;
}
.table-heading {
    display: flex;
    justify-content: space-between;
    gap: 16px;
    align-items: center;
    flex-shrink: 0;
    padding: 14px 16px;
    border-bottom: 1px solid var(--da-border);
    font-size: 14px;
}
.table-heading strong {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.heading-right {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-shrink: 0;
}
.table-heading span,
.table-footer,
.empty {
    color: var(--da-text-muted);
    font-size: 12px;
}
.table-warning {
    flex-shrink: 0;
    margin: 0;
    padding: 8px 16px;
    color: var(--status-warning);
    font-size: 12px;
}
.table-scroll {
    overflow: auto;
    min-height: 0;
    max-height: 420px;
}
table {
    width: 100%;
    border-collapse: collapse;
    font-size: 13px;
    white-space: nowrap;
}
th,
td {
    padding: 10px 14px;
    border-bottom: 1px solid var(--da-border);
    text-align: left;
}
th {
    position: sticky;
    top: 0;
    background: var(--da-panel);
    color: var(--da-text-muted);
    font-weight: 600;
}
tbody tr:hover {
    background: color-mix(in srgb, var(--da-text-muted) 6%, transparent);
}
.table-footer {
    flex-shrink: 0;
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 10px 16px;
}
p[role='alert'],
.empty {
    padding: 12px 16px;
}
button {
    border: 1px solid var(--da-border);
    border-radius: 6px;
    padding: 6px 10px;
    background: transparent;
    color: var(--da-text-main);
    cursor: pointer;
}
button:disabled {
    opacity: 0.5;
    cursor: default;
}
</style>
