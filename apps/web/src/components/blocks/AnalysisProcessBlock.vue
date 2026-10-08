<template>
    <section class="process" aria-label="分析过程">
        <button class="process-summary" type="button" :aria-expanded="!collapsed" @click="collapsed = !collapsed">
            <span class="summary-icon" :class="summaryTone"><i :class="summaryIcon"></i></span>
            <span class="summary-label">{{ summaryLabel }}</span>
            <span v-if="!isStreaming" class="summary-meta">{{ summaryMeta }}</span>
            <i class="fas fa-chevron-down toggle" :class="{ expanded: !collapsed }"></i>
        </button>

        <div v-if="!collapsed" class="activity-list">
            <template v-for="activity in activities" :key="activity.id">
                <button
                    class="activity-pill"
                    :class="`is-${activity.status}`"
                    type="button"
                    :aria-expanded="isCurrent(activity) || expanded.has(activity.id)"
                    @click="toggle(activity.id)"
                >
                    <span class="activity-icon"><i :class="iconFor(activity)"></i></span>
                    <span class="activity-label">{{ activity.label }}</span>
                    <span v-if="activity.subject" class="activity-subject">{{ activity.subject }}</span>
                    <span v-if="activity.status !== 'running' && activity.durationMs !== undefined" class="activity-meta">{{ formatDuration(activity.durationMs) }}</span>
                    <i class="fas fa-chevron-down toggle" :class="{ expanded: isCurrent(activity) || expanded.has(activity.id) }"></i>
                </button>

                <div v-if="isCurrent(activity) || expanded.has(activity.id)" class="activity-details">
                    <dl v-if="activity.details.length" class="detail-grid">
                        <template v-for="item in activity.details" :key="item.label">
                            <dt>{{ item.label }}</dt>
                            <dd>
                                <details v-if="item.label === '完整字段列表'">
                                    <summary>查看 {{ Array.isArray(item.value) ? item.value.length : 1 }} 个字段</summary>
                                    <div class="secondary-values">
                                        <span v-for="value in asList(item.value)" :key="value" class="value-tag">{{ value }}</span>
                                    </div>
                                </details>
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
                        <button type="button" @click="toggleResult(activity)">
                            <i class="fas fa-table"></i>
                            {{ resultOpen.has(activity.id) ? '收起结果' : '查看结果' }}
                        </button>
                        <button type="button" @click="toggleSql(activity.id)">
                            <i class="fas fa-code"></i>
                            {{ sqlOpen.has(activity.id) ? '收起 SQL' : '查看 SQL' }}
                        </button>
                    </div>

                    <div v-if="activity.query && resultOpen.has(activity.id)" class="nested-evidence">
                        <p v-if="artifacts[activity.query.artifactId]?.error" role="alert">
                            {{ artifacts[activity.query.artifactId]?.error }}
                            <button type="button" @click="loadArtifact(activity, true)">重试</button>
                        </p>
                        <p v-else-if="artifacts[activity.query.artifactId]?.loading" class="muted">正在读取完整结果…</p>
                        <template v-else-if="artifacts[activity.query.artifactId]?.metadata">
                            <p class="loaded-count">
                                已加载 {{ artifacts[activity.query.artifactId]?.rows.length }} / {{ artifacts[activity.query.artifactId]?.metadata?.returnedRowCount }} 行
                            </p>
                            <TableBlock
                                :title="activity.subject || '查询结果'"
                                :columns="artifacts[activity.query.artifactId]?.metadata?.columns.map((column) => column.name)"
                                :rows="artifacts[activity.query.artifactId]?.rows"
                                :row-count="artifacts[activity.query.artifactId]?.metadata?.returnedRowCount"
                                :is-limited="artifacts[activity.query.artifactId]?.metadata?.isLimited"
                                :max-display="1000"
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

                    <div v-if="activity.query && sqlOpen.has(activity.id)" class="nested-evidence">
                        <p v-if="activity.query.adjusted" class="adjusted"><i class="fas fa-info-circle"></i> 实际执行 SQL 已经过安全限制或格式调整。</p>
                        <SqlBlock title="实际执行 SQL" :content="activity.query.executedSql" />
                        <SqlBlock v-if="activity.query.adjusted" title="原始 SQL" :content="activity.query.originalSql" />
                    </div>
                </div>
            </template>
        </div>
    </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { AnalysisActivityDetailV1, AnalysisActivityV1, ArtifactColumnV1 } from '@gist/contracts';
import { apiFetch } from '../../api';
import { useChatStore } from '../../stores/chat';
import type { MessageBlock } from '../../types';
import { cloneAnalysisActivity } from '../../utils/analysis-activity.js';
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

const props = defineProps<{ blocks: MessageBlock[]; isStreaming: boolean; terminalStatus?: 'completed' | 'failed' | 'cancelled' }>();
const chat = useChatStore();
const collapsed = ref(!props.isStreaming);
const expanded = ref(new Set<string>());
const resultOpen = ref(new Set<string>());
const sqlOpen = ref(new Set<string>());
const artifacts = ref<Record<string, ArtifactView>>({});
const hasFormalResult = computed(() => props.blocks.some((block) => block.type === 'text' && !!block.analysis));

watch(
    () => [props.isStreaming, hasFormalResult.value] as const,
    ([streaming, hasResult]) => {
        collapsed.value = !streaming || hasResult;
        if (!streaming || hasResult) expanded.value = new Set();
    }
);

const rawActivities = computed(() =>
    props.blocks
        .filter((block): block is MessageBlock & { activity: AnalysisActivityV1 } => block.type === 'analysis_activity' && !!block.activity && block.activity.kind !== 'inspect_evidence')
        .map((block) => block.activity)
);

const mergeable = new Set<AnalysisActivityV1['kind']>(['inspect_catalog', 'inspect_memory', 'inspect_schema']);
const activities = computed(() => {
    const merged: AnalysisActivityV1[] = [];
    for (const activity of rawActivities.value) {
        const previous = merged.at(-1);
        if (
            previous &&
            previous.kind === activity.kind &&
            previous.groupId === activity.groupId &&
            mergeable.has(activity.kind) &&
            previous.status === 'completed' &&
            activity.status === 'completed'
        ) {
            previous.subject = unique([...(previous.subject?.split('、') || []), ...(activity.subject?.split('、') || [])]).join('、');
            previous.details = mergeDetails(previous.details, activity.details);
            previous.durationMs = (previous.durationMs || 0) + (activity.durationMs || 0);
            previous.completedAt = activity.completedAt;
            continue;
        }
        merged.push(cloneAnalysisActivity(activity));
    }
    return merged;
});

function mergeDetails(left: AnalysisActivityDetailV1[], right: AnalysisActivityDetailV1[]): AnalysisActivityDetailV1[] {
    const values = new Map<string, string[]>();
    for (const item of [...left, ...right]) {
        const next = Array.isArray(item.value) ? item.value : [item.value];
        values.set(item.label, unique([...(values.get(item.label) || []), ...next]));
    }
    return [...values].map(([label, value]) => ({ label, value: value.length === 1 ? value[0] : value }));
}

function unique(values: string[]): string[] {
    return [...new Set(values.filter(Boolean))];
}

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
function toggleSql(id: string) {
    replaceSet(sqlOpen, id);
}
async function toggleResult(activity: AnalysisActivityV1) {
    replaceSet(resultOpen, activity.id);
    if (resultOpen.value.has(activity.id)) await loadArtifact(activity);
}

async function loadArtifact(activity: AnalysisActivityV1, force = false) {
    const query = activity.query;
    const conversationId = chat.activeConversationId;
    if (!query || !conversationId || (!force && artifacts.value[query.artifactId]?.metadata)) return;
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

const currentActivityId = computed(() => [...activities.value].reverse().find((activity) => activity.status === 'running')?.id);
function isCurrent(activity: AnalysisActivityV1) {
    return activity.status === 'running' && activity.id === currentActivityId.value;
}
function iconFor(activity: AnalysisActivityV1): string {
    if (activity.status === 'running') return 'fas fa-circle-notch fa-spin';
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
    if (props.isStreaming) return hasFormalResult.value ? '正在完成分析' : activities.value.at(-1)?.label || '正在分析';
    if (props.terminalStatus === 'failed') return '分析未完成';
    if (props.terminalStatus === 'cancelled') return '分析已停止';
    return '分析完成';
});
const summaryMeta = computed(() => {
    const parts = [`${activities.value.length} 个动作`];
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
    cursor: pointer;
    transition:
        background 0.18s ease,
        border-color 0.18s ease;
}
.process-summary:hover,
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
.detail-grid summary {
    cursor: pointer;
    color: var(--da-text-main);
}
.secondary-values {
    margin-top: 6px;
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
.nested-evidence {
    margin-top: 10px;
}
.nested-evidence :deep(.sql-block),
.nested-evidence :deep(.table-block) {
    box-shadow: none;
}
.nested-evidence :deep(.sql-block) + :deep(.sql-block) {
    margin-top: 8px;
}
.load-more {
    margin-top: 8px;
}
.loaded-count {
    margin: 0 0 6px;
    color: var(--da-text-muted);
}
.adjusted {
    color: var(--status-warning);
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
