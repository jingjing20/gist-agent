<template>
    <p v-if="error" role="alert">{{ error }} <Button variant="outline" size="sm" @click="load">重试</Button></p>
    <p v-else-if="!metadata">正在读取依据…</p>
    <div v-else class="evidence-document">
        <dl>
            <dt>查询目的</dt>
            <dd>{{ metadata.purpose || metadata.title }}</dd>
            <dt>查询时间</dt>
            <dd>{{ new Date(metadata.createdAt).toLocaleString() }}</dd>
            <dt>数据粒度</dt>
            <dd>{{ metadata.expectedGrain || '未记录' }}</dd>
            <dt>返回记录</dt>
            <dd>{{ metadata.returnedRowCount }} 行{{ metadata.isLimited ? '（结果截断）' : '' }}</dd>
            <dt>时间范围</dt>
            <dd>{{ range(metadata.context?.state.timeRange) }}</dd>
            <dt>对比范围</dt>
            <dd>{{ range(metadata.context?.state.comparisonRange) }}</dd>
            <dt>筛选条件</dt>
            <dd>{{ filters }}</dd>
            <dt>临时口径</dt>
            <dd>{{ metadata.context?.state.temporaryNotes.map((item) => `${item.name}：${item.description}`).join('；') || '无' }}</dd>
        </dl>
        <p v-if="metadata.isLimited" class="warning">查询结果截断，不能视为完整总体。</p>
        <p v-if="metadata.returnedRowCount === 0" class="warning">查询结果为空，不能据此认定业务数量为零。</p>
        <p v-for="warning in metadata.quality?.warnings" :key="warning.message" class="warning">{{ warning.message }} {{ warning.action }}</p>
        <details v-for="memory in metadata.context?.memories" :key="memory.id">
            <summary>{{ memory.name }} · v{{ memory.version }}（查询时口径）</summary>
            <MemoryContent :content="memory" />
        </details>
        <SqlBlock title="实际执行 SQL" :content="metadata.executedSql" />
        <details v-if="metadata.originalSql !== metadata.executedSql">
            <summary>查看调整前的 SQL</summary>
            <SqlBlock title="原始 SQL" :content="metadata.originalSql" />
        </details>
    </div>
</template>
<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { AnalysisEvidenceContext, AnalysisState, ResultQualityV1 } from '@gist/contracts';
import { apiFetch } from '../../api';
import { Button } from '../ui/button';
import SqlBlock from './SqlBlock.vue';
import MemoryContent from '../MemoryContent.vue';
const props = defineProps<{ artifactId: string; conversationId: string }>();
interface Metadata {
    title: string;
    purpose: string;
    expectedGrain: string;
    createdAt: string;
    returnedRowCount: number;
    isLimited: boolean;
    context?: AnalysisEvidenceContext;
    quality?: ResultQualityV1;
    executedSql: string;
    originalSql: string;
}
const metadata = ref<Metadata>();
const error = ref('');
let revision = 0;
function range(value: AnalysisState['timeRange'] | undefined) {
    return value ? `${value.start} 至 ${value.endExclusive}（结束不含，${value.timezone}）` : '未指定';
}
const filters = computed(() => metadata.value?.context?.state.filters.map((item) => `${item.field} ${item.operator} ${JSON.stringify(item.value)}`).join('；') || '无');
async function load() {
    const current = ++revision;
    metadata.value = undefined;
    error.value = '';
    try {
        const response = await apiFetch(`/analysis-artifacts/${encodeURIComponent(props.artifactId)}?conversationId=${encodeURIComponent(props.conversationId)}`);
        if (!response.ok) throw new Error((await response.json().catch(() => ({}))).message || '读取依据失败');
        const data: Metadata = await response.json();
        if (current === revision) metadata.value = data;
    } catch (cause) {
        if (current === revision) error.value = cause instanceof Error ? cause.message : '读取依据失败';
    }
}
watch(
    () => [props.artifactId, props.conversationId],
    () => void load(),
    { immediate: true }
);
</script>
<style scoped>
.evidence-document {
    display: flex;
    flex-direction: column;
    gap: 16px;
    overflow-wrap: anywhere;
}
dl {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    gap: 10px 20px;
}
dt {
    color: var(--da-text-muted);
}
dd {
    margin: 0;
}
.warning {
    color: var(--status-warning);
}
summary {
    cursor: pointer;
}
</style>
