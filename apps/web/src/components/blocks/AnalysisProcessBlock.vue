<template>
    <section class="process" aria-label="分析过程">
        <div v-if="mode === 'summary'" class="process-summary" role="status">
            <span class="summary-icon" :class="summaryTone"><i :class="summaryIcon"></i></span>
            <span class="summary-label">{{ summaryLabel }}</span>
            <span class="summary-meta">{{ summaryMeta }}</span>
        </div>

        <div v-else class="activity-list">
            <template v-for="activity in activities" :key="activity.id">
                <button class="activity-pill" :class="`is-${activity.status}`" type="button" :aria-expanded="expanded.has(activity.id)" @click="toggle(activity.id)">
                    <span class="activity-icon"><i :class="iconFor(activity)"></i></span>
                    <span class="activity-label">{{ activity.label }}</span>
                    <span v-if="activity.subject" class="activity-subject">{{ activity.subject }}</span>
                    <span v-if="activity.status === 'running'" class="activity-loading" role="status" aria-label="正在执行">
                        <i class="fas fa-circle-notch fa-spin" aria-hidden="true"></i>
                    </span>
                    <span v-else-if="activity.durationMs !== undefined" class="activity-meta" title="工具执行耗时（不含模型思考与生成参数）">{{
                        formatDuration(activity.durationMs)
                    }}</span>
                    <i class="fas fa-chevron-down toggle" :class="{ expanded: expanded.has(activity.id) }"></i>
                </button>

                <div v-if="expanded.has(activity.id)" class="activity-details">
                    <dl v-if="activity.details.length" class="detail-grid">
                        <template v-for="item in activity.details" :key="item.label">
                            <dt>{{ item.label }}</dt>
                            <dd>
                                <Dialog v-if="item.label === '完整字段列表'">
                                    <DialogTrigger as-child>
                                        <button type="button" class="fields-trigger">查看 {{ asList(item.value).length }} 个字段</button>
                                    </DialogTrigger>
                                    <DialogContent class="flex max-h-[85dvh] min-h-0 flex-col overflow-hidden sm:max-w-3xl">
                                        <DialogHeader class="min-w-0 pr-8">
                                            <DialogTitle>完整字段列表</DialogTitle>
                                            <DialogDescription class="break-words"
                                                >{{ activity.subject || '数据表' }} · 本次读取 {{ asList(item.value).length }} 个字段</DialogDescription
                                            >
                                        </DialogHeader>
                                        <ol class="fields-list evidence-panel" aria-label="字段列表">
                                            <li v-for="(value, index) in asList(item.value)" :key="index">
                                                <span class="field-index" aria-hidden="true">{{ index + 1 }}</span>
                                                <code>{{ value }}</code>
                                            </li>
                                        </ol>
                                    </DialogContent>
                                </Dialog>
                                <template v-else-if="Array.isArray(item.value)">
                                    <span v-for="value in item.value" :key="value" class="value-tag">{{ value }}</span>
                                </template>
                                <template v-else>{{ item.value }}</template>
                            </dd>
                        </template>
                    </dl>
                    <p v-if="activity.status === 'running' && !activity.details.length" class="muted">正在执行该动作…</p>
                    <div v-if="activity.qualityMessages?.length" class="quality-messages">
                        <p v-for="message in activity.qualityMessages" :key="`${message.severity}:${message.message}`" class="quality-message" :class="`is-${message.severity}`">
                            <i :class="message.severity === 'info' ? 'fas fa-info-circle' : 'fas fa-exclamation-circle'"></i>
                            {{ message.message }}
                        </p>
                    </div>
                    <p v-else-if="activity.warning" class="warning">{{ activity.warning }}</p>

                    <div v-if="activity.query" class="evidence-actions">
                        <Dialog>
                            <DialogTrigger as-child>
                                <button type="button" @click="loadArtifact(activity)"><i class="fas fa-table" aria-hidden="true"></i> 查看结果</button>
                            </DialogTrigger>
                            <DialogContent class="flex max-h-[85dvh] min-h-0 flex-col overflow-hidden sm:max-w-6xl">
                                <DialogHeader class="min-w-0 pr-8">
                                    <DialogTitle>查询结果</DialogTitle>
                                    <DialogDescription class="break-words">{{ activity.subject || '查询数据' }}</DialogDescription>
                                </DialogHeader>
                                <div class="evidence-panel">
                                    <p v-if="artifacts[activity.query.artifactId]?.error" role="alert">
                                        {{ artifacts[activity.query.artifactId]?.error }}
                                        <button type="button" @click="loadArtifact(activity, true)">重试</button>
                                    </p>
                                    <p v-if="artifacts[activity.query.artifactId]?.loading" class="muted">正在读取完整结果…</p>
                                    <template v-else-if="artifacts[activity.query.artifactId]?.metadata">
                                        <p v-if="!artifacts[activity.query.artifactId]?.rows.length" class="muted" role="status">查询结果为空。</p>
                                        <p class="loaded-count">
                                            已加载 {{ artifacts[activity.query.artifactId]?.rows.length }} /
                                            {{ artifacts[activity.query.artifactId]?.metadata?.returnedRowCount }} 行
                                        </p>
                                        <TableBlock
                                            :title="activity.subject || '查询结果'"
                                            :columns="artifacts[activity.query.artifactId]?.metadata?.columns.map((column) => column.name)"
                                            :rows="artifacts[activity.query.artifactId]?.rows"
                                            :row-count="artifacts[activity.query.artifactId]?.metadata?.returnedRowCount"
                                            :is-limited="artifacts[activity.query.artifactId]?.metadata?.isLimited"
                                            :max-display="artifacts[activity.query.artifactId]?.rows.length"
                                        />
                                        <button
                                            v-if="artifacts[activity.query.artifactId]?.nextCursor"
                                            class="load-more"
                                            type="button"
                                            :disabled="artifacts[activity.query.artifactId]?.loadingMore"
                                            @click="loadMore(activity)"
                                        >
                                            {{ artifacts[activity.query.artifactId]?.loadingMore ? '正在加载…' : '加载更多结果' }}
                                        </button>
                                    </template>
                                </div>
                            </DialogContent>
                        </Dialog>
                        <Dialog>
                            <DialogTrigger as-child>
                                <button type="button"><i class="fas fa-code" aria-hidden="true"></i> 查看 SQL</button>
                            </DialogTrigger>
                            <DialogContent class="flex max-h-[85dvh] min-h-0 flex-col overflow-hidden sm:max-w-6xl">
                                <DialogHeader class="min-w-0 pr-8">
                                    <DialogTitle>查询 SQL</DialogTitle>
                                    <DialogDescription class="break-words">{{ activity.subject || '查询数据' }}</DialogDescription>
                                </DialogHeader>
                                <TabsRoot default-value="executed" class="flex min-h-0 flex-col gap-4">
                                    <TabsList v-if="activity.query.adjusted" class="sql-tabs" aria-label="SQL 版本">
                                        <TabsTrigger value="executed">实际执行 SQL</TabsTrigger>
                                        <TabsTrigger value="original">原始 SQL</TabsTrigger>
                                    </TabsList>
                                    <p v-if="activity.query.adjusted" class="sql-note">执行前系统会规范 SQL 并限制返回行数，可切换查看原始语句。</p>
                                    <TabsContent value="executed" class="evidence-panel">
                                        <SqlBlock title="实际执行 SQL" :content="activity.query.executedSql" />
                                    </TabsContent>
                                    <TabsContent v-if="activity.query.adjusted" value="original" class="evidence-panel">
                                        <SqlBlock title="原始 SQL" :content="activity.query.originalSql" />
                                    </TabsContent>
                                </TabsRoot>
                            </DialogContent>
                        </Dialog>
                    </div>
                </div>
            </template>
        </div>
    </section>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { TabsContent, TabsList, TabsRoot, TabsTrigger } from 'reka-ui';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '../ui/dialog';
import type { AnalysisActivityV1, ArtifactColumnV1 } from '@gist/contracts';
import { apiFetch } from '../../api';
import { useChatStore } from '../../stores/chat';
import type { MessageBlock } from '../../types';
import SqlBlock from './SqlBlock.vue';
import TableBlock from './TableBlock.vue';

interface ArtifactView {
    loading?: boolean;
    loadingMore?: boolean;
    error?: string;
    metadata?: { columns: ArtifactColumnV1[]; returnedRowCount: number; isLimited: boolean };
    rows: Record<string, unknown>[];
    nextCursor: string | null;
}

const props = defineProps<{ mode: 'summary' | 'inline'; blocks: MessageBlock[]; isStreaming: boolean; terminalStatus?: 'completed' | 'failed' | 'cancelled' }>();
const chat = useChatStore();
const expanded = ref(new Set<string>());
const artifacts = ref<Record<string, ArtifactView>>({});
const hasFormalResult = computed(() => props.blocks.some((block) => block.type === 'text' && !!block.analysis));
// Preserve each call's position; completion updates replace the same block in place.
const activities = computed(() =>
    props.blocks
        .filter(
            (block): block is MessageBlock & { activity: AnalysisActivityV1 } =>
                block.type === 'analysis_activity' && !!block.activity && block.activity.kind !== 'inspect_evidence'
        )
        .map((block) => block.activity)
);

function asList(value: string | string[]): string[] {
    return Array.isArray(value) ? value : [value];
}

function replaceSet(target: typeof expanded, id: string) {
    const next = new Set(target.value);
    next.has(id) ? next.delete(id) : next.add(id);
    target.value = next;
}

function toggle(id: string) {
    replaceSet(expanded, id);
}
async function loadArtifact(activity: AnalysisActivityV1, force = false) {
    const query = activity.query;
    const conversationId = chat.activeConversationId;
    if (!query || !conversationId || (!force && (artifacts.value[query.artifactId]?.metadata || artifacts.value[query.artifactId]?.loading))) return;
    artifacts.value[query.artifactId] = { rows: [], nextCursor: null, loading: true };
    try {
        const suffix = `conversationId=${encodeURIComponent(conversationId)}`;
        const [metadataResponse, rowsResponse] = await Promise.all([
            apiFetch(`/analysis-artifacts/${encodeURIComponent(query.artifactId)}?${suffix}`),
            apiFetch(`/analysis-artifacts/${encodeURIComponent(query.artifactId)}/rows?${suffix}&limit=50`),
        ]);
        if (!metadataResponse.ok || !rowsResponse.ok) throw new Error('查询结果读取失败');
        const metadata = await metadataResponse.json();
        const page = await rowsResponse.json();
        artifacts.value[query.artifactId] = { metadata, rows: page.rows, nextCursor: page.nextCursor, loading: false };
    } catch (error) {
        artifacts.value[query.artifactId] = { rows: [], nextCursor: null, loading: false, error: error instanceof Error ? error.message : '查询结果读取失败' };
    }
}

async function loadMore(activity: AnalysisActivityV1) {
    const query = activity.query;
    const conversationId = chat.activeConversationId;
    if (!query || !conversationId) return;
    const state = artifacts.value[query.artifactId];
    if (!state?.nextCursor || state.loadingMore) return;
    state.loadingMore = true;
    try {
        const response = await apiFetch(
            `/analysis-artifacts/${encodeURIComponent(query.artifactId)}/rows?conversationId=${encodeURIComponent(conversationId)}&limit=50&cursor=${encodeURIComponent(state.nextCursor)}`
        );
        if (!response.ok) throw new Error('更多结果读取失败');
        const page = await response.json();
        state.rows.push(...page.rows);
        state.nextCursor = page.nextCursor;
    } catch (error) {
        state.error = error instanceof Error ? error.message : '更多结果读取失败';
    } finally {
        state.loadingMore = false;
    }
}

function iconFor(activity: AnalysisActivityV1): string {
    if (activity.status === 'warning') return 'fas fa-exclamation-circle';
    if (activity.kind === 'query_data') return 'fas fa-terminal';
    if (activity.kind === 'generate_chart') return 'fas fa-chart-line';
    if (['inspect_catalog', 'inspect_schema'].includes(activity.kind)) return 'fas fa-database';
    return 'fas fa-check';
}
function formatDuration(value: number): string {
    return value < 1000 ? `${value}ms` : `${(value / 1000).toFixed(1)}s`;
}

const queryCount = computed(() => activities.value.filter((item) => item.kind === 'query_data' && item.status !== 'running').length);
const chartCount = computed(() => activities.value.filter((item) => item.kind === 'generate_chart' && item.status !== 'running').length);
const hasWarnings = computed(() => activities.value.some((item) => item.status === 'warning'));
const summaryLabel = computed(() => {
    if (props.isStreaming) return hasFormalResult.value ? '正在完成分析' : '正在分析';
    if (props.terminalStatus === 'failed') return '分析未完成';
    if (props.terminalStatus === 'cancelled') return '分析已停止';
    return '分析完成';
});
const summaryMeta = computed(() => {
    const completed = activities.value.filter((activity) => activity.status !== 'running').length;
    const parts = [props.isStreaming ? `${completed} / ${activities.value.length} 个动作` : `${activities.value.length} 个动作`];
    if (queryCount.value) parts.push(`${queryCount.value} 次查询`);
    if (chartCount.value) parts.push(`${chartCount.value} 张图表`);
    return parts.join(' · ');
});
const summaryTone = computed(() => {
    if (props.terminalStatus === 'failed' || props.terminalStatus === 'cancelled') return 'warning';
    if (props.isStreaming) return 'running';
    return hasWarnings.value ? 'warning' : 'completed';
});
const summaryIcon = computed(() => {
    if (props.terminalStatus === 'failed' || props.terminalStatus === 'cancelled') return 'fas fa-exclamation-circle';
    if (props.isStreaming) return 'fas fa-circle-notch fa-spin';
    return hasWarnings.value ? 'fas fa-exclamation-circle' : 'fas fa-check';
});
</script>

<style scoped>
.process {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 10px;
}
.process-summary,
.activity-pill {
    appearance: none;
    border: 1px solid color-mix(in srgb, var(--da-text-muted) 14.000000000000002%, transparent);
    background: color-mix(in srgb, var(--da-text-muted) 9%, transparent);
    color: var(--da-text-main);
    border-radius: 8px;
    min-height: 32px;
    padding: 6px 10px;
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font: inherit;
    transition:
        background 0.18s ease,
        border-color 0.18s ease;
}
.activity-pill:hover {
    background: color-mix(in srgb, var(--da-text-muted) 14.000000000000002%, transparent);
    border-color: color-mix(in srgb, var(--da-text-muted) 25%, transparent);
}
.process-summary {
    font-size: 13px;
}
.summary-icon,
.activity-icon {
    width: 16px;
    display: inline-flex;
    justify-content: center;
    color: var(--status-success);
}
.summary-icon.running,
.activity-pill.is-running .activity-icon {
    color: var(--da-primary);
}
.summary-icon.warning,
.activity-pill.is-warning .activity-icon,
.warning,
[role='alert'] {
    color: var(--status-warning);
}
.quality-messages {
    margin-top: 8px;
}
.quality-message {
    margin: 3px 0;
}
.quality-message i {
    margin-right: 5px;
}
.quality-message.is-info {
    color: var(--da-text-muted);
}
.quality-message.is-warning,
.quality-message.is-blocking {
    color: var(--status-warning);
}
.summary-label,
.activity-label {
    font-weight: 600;
    white-space: nowrap;
}
.summary-meta,
.activity-subject,
.activity-meta,
.muted {
    color: var(--da-text-muted);
}
.activity-subject {
    padding-left: 8px;
    border-left: 1px solid color-mix(in srgb, var(--da-text-muted) 24%, transparent);
    max-width: min(440px, 55vw);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.activity-loading {
    display: inline-flex;
    width: 16px;
    justify-content: center;
    color: var(--da-primary);
}
.toggle {
    color: var(--da-text-muted);
    font-size: 10px;
    transition: transform 0.18s ease;
}
.toggle.expanded {
    transform: rotate(180deg);
}
.activity-list {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 10px;
    width: 100%;
    padding-left: 2px;
}
.activity-pill {
    max-width: 100%;
    font-size: 12px;
    cursor: pointer;
}
.activity-details {
    margin: -4px 0 0 10px;
    padding: 10px 12px;
    width: min(760px, calc(100% - 12px));
    border-left: 1px solid var(--da-border);
    font-size: 12px;
    line-height: 1.6;
    box-sizing: border-box;
}
.detail-grid {
    display: grid;
    grid-template-columns: max-content minmax(0, 1fr);
    gap: 7px 16px;
    margin: 0;
}
.detail-grid dt {
    color: var(--da-text-muted);
}
.detail-grid dd {
    margin: 0;
    color: var(--da-text-main);
    overflow-wrap: anywhere;
}
.value-tag {
    display: inline-block;
    margin: 0 6px 4px 0;
    padding: 1px 7px;
    border-radius: 5px;
    background: color-mix(in srgb, var(--da-text-muted) 9%, transparent);
}
.fields-trigger {
    appearance: none;
    border: 1px solid var(--da-border);
    border-radius: 6px;
    padding: 4px 8px;
    background: transparent;
    color: var(--da-text-main);
    font: inherit;
    cursor: pointer;
}
.fields-trigger:hover {
    border-color: var(--da-primary);
}
.fields-trigger:focus-visible {
    outline: 2px solid var(--da-primary);
    outline-offset: 2px;
}
.fields-list {
    list-style: none;
    padding: 0;
    margin: 0;
}
.fields-list li {
    display: flex;
    align-items: baseline;
    gap: 16px;
    padding: 10px 12px;
    border-bottom: 1px solid var(--da-border);
}
.fields-list li:last-child {
    border-bottom: 0;
}
.field-index {
    min-width: 2ch;
    flex-shrink: 0;
    color: var(--da-text-muted);
    font-variant-numeric: tabular-nums;
}
.fields-list code {
    min-width: 0;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    color: var(--da-text-main);
}
.evidence-actions {
    display: flex;
    gap: 8px;
    margin-top: 12px;
}
.evidence-actions button,
.load-more,
[role='alert'] button {
    border: 1px solid var(--da-border);
    border-radius: 6px;
    padding: 6px 9px;
    background: color-mix(in srgb, var(--da-text-muted) 7.000000000000001%, transparent);
    color: var(--da-text-main);
    cursor: pointer;
}
.evidence-actions button:hover,
.load-more:hover {
    border-color: var(--da-primary);
}
.evidence-panel {
    min-height: 0;
    overflow: auto;
    overscroll-behavior: contain;
}
.evidence-panel :deep(.sql-block) + :deep(.sql-block) {
    margin-top: 12px;
}
.evidence-panel :deep(.sql-code),
.evidence-panel :deep(.table-wrapper) {
    scrollbar-width: auto;
}
.evidence-panel :deep(.no-scrollbar)::-webkit-scrollbar {
    display: block;
    height: 8px;
    width: 8px;
}
.load-more {
    margin-top: 8px;
}
.loaded-count {
    margin: 0 0 6px;
    color: var(--da-text-muted);
}
.sql-note {
    margin: 0;
    color: var(--da-text-muted);
    font-size: 12px;
}
.sql-tabs {
    display: flex;
    flex-shrink: 0;
    gap: 20px;
    border-bottom: 1px solid var(--da-border);
}
.sql-tabs :deep(button) {
    appearance: none;
    margin: 0 0 -1px;
    padding: 10px 4px;
    border: 0;
    border-bottom: 2px solid transparent;
    border-radius: 0;
    background: transparent;
    box-shadow: none;
    color: var(--da-text-muted);
    font: inherit;
    cursor: pointer;
}
.sql-tabs :deep(button:hover),
.sql-tabs :deep(button[data-state='active']) {
    color: var(--da-text-main);
}
.sql-tabs :deep(button[data-state='active']) {
    border-bottom-color: var(--da-primary);
}
.sql-tabs :deep(button:focus-visible) {
    outline: 2px solid var(--da-primary);
    outline-offset: 2px;
}
@media (max-width: 640px) {
    .summary-meta {
        display: none;
    }
    .activity-subject {
        max-width: 45vw;
    }
    .detail-grid {
        grid-template-columns: 1fr;
        gap: 3px;
    }
    .detail-grid dd {
        margin-bottom: 7px;
    }
}
</style>
