<template>
    <section class="analysis-result">
        <p v-if="outcome.kind !== 'response' && outcome.kind !== 'table' && outcome.kind !== 'direct'" class="status" :class="{ partial: outcome.kind === 'partial' }">
            {{
                outcome.kind === 'partial' ? '部分结果 · 仍有待查项' : outcome.kind === 'clarification' ? '需要补充信息' : outcome.kind === 'refusal' ? '本次无法分析' : '分析结果'
            }}
        </p>
        <template v-if="outcome.kind === 'response'">
            <p v-if="outcome.status === 'partial'" class="partial-reason">部分结果：{{ outcome.reason }}</p>
            <div class="composed-result">
                <template v-for="(block, index) in outcome.blocks" :key="index">
                    <MarkdownBlock :is-streaming="isStreaming" v-if="block.type === 'markdown'" :content="block.content" />
                    <AnalysisArtifactTable
                        v-else-if="block.type === 'table'"
                        :artifact-id="block.artifactId"
                        :conversation-id="analysis.state.conversationId"
                        :title="block.title"
                    />
                    <ChartBlock v-else-if="chartFor(block.chartArtifactId)" :chart-data="chartFor(block.chartArtifactId)?.chartData" />
                    <p v-else class="missing-chart">图表暂时无法读取。</p>
                </template>
            </div>
        </template>
        <template v-if="outcome.kind === 'table'">
            <div class="result-tables">
                <AnalysisArtifactTable
                    v-for="table in outcome.tables"
                    :key="table.artifactId"
                    :artifact-id="table.artifactId"
                    :conversation-id="analysis.state.conversationId"
                    :title="table.title"
                />
            </div>
            <p v-if="outcome.note" class="table-note">{{ outcome.note }}</p>
        </template>
        <MarkdownBlock :is-streaming="isStreaming" v-if="outcome.kind === 'direct'" :content="outcome.content" />
        <template v-if="outcome.kind === 'answer' || outcome.kind === 'partial'">
            <header class="report-header">
                <h2>核心结论</h2>
                <MarkdownBlock :is-streaming="isStreaming" class="report-summary" :content="outcome.answer.summary" />
                <ul v-if="outcome.answer.keyPoints?.length" class="key-points">
                    <li v-for="point in outcome.answer.keyPoints" :key="point">{{ point }}</li>
                </ul>
                <p v-if="outcome.kind === 'partial' && outcome.reason" class="partial-reason">尚未完成：{{ outcome.reason }}</p>
            </header>
            <section v-if="outcome.answer.metrics?.length || primaryChart" class="report-section">
                <h3>关键数据与图表</h3>
                <div v-if="outcome.answer.metrics?.length" class="metric-grid">
                    <div v-for="metric in outcome.answer.metrics" :key="metric.findingId + metric.label" class="metric-card">
                        <span class="metric-label">{{ metric.label }}</span>
                        <strong class="metric-value">{{ metric.value }}</strong>
                        <span v-if="metric.detail" class="metric-detail">{{ metric.detail }}</span>
                    </div>
                </div>
                <div v-if="primaryChart" class="featured-chart"><ChartBlock :chart-data="primaryChart.chartData" /></div>
            </section>
            <section v-if="outcome.answer.findings.length" class="report-section">
                <h3>分析发现</h3>
                <article v-for="(finding, index) in outcome.answer.findings" :key="finding.id" class="finding-card">
                    <div class="finding-heading">
                        <span class="finding-index">{{ String(index + 1).padStart(2, '0') }}</span
                        ><span class="finding-kind" :class="finding.kind">{{ kinds[finding.kind] }}</span>
                    </div>
                    <MarkdownBlock :is-streaming="isStreaming" class="finding-text" :content="finding.text" />
                    <div v-for="chart in chartsForFinding(finding)" :key="chart.chartArtifactId || chart.title" class="finding-chart">
                        <ChartBlock :chart-data="chart.chartData" />
                    </div>
                    <details v-for="ref in finding.evidence" :key="ref.artifactId + ref.role" @toggle="openEvidence($event, ref.artifactId)">
                        <summary>{{ roles[ref.role] }}{{ ref.comparisonLabel ? ` · ${ref.comparisonLabel}` : '' }} · 展开证据</summary>
                        <p v-if="errors[ref.artifactId]" role="alert">{{ errors[ref.artifactId] }} <button @click="loadEvidence(ref.artifactId)">重试</button></p>
                        <p v-else-if="!evidence[ref.artifactId]">正在读取证据…</p>
                        <template v-else>
                            <p>{{ evidence[ref.artifactId]!.purpose }} · 结果粒度：{{ evidence[ref.artifactId]!.expectedGrain }}</p>
                            <p>查询时间：{{ evidence[ref.artifactId]!.createdAt }} · 返回 {{ evidence[ref.artifactId]!.returnedRowCount }} 行</p>
                            <p v-if="evidence[ref.artifactId]!.isLimited" class="warning">查询结果受限，不能视为完整总体。</p>
                            <p v-if="evidence[ref.artifactId]!.returnedRowCount === 0" class="warning">查询结果为空；不能据此认定业务数量为零。</p>
                            <p v-for="(warning, i) in evidence[ref.artifactId]!.quality?.warnings" :key="i" class="warning">{{ warning.message }} {{ warning.action }}</p>
                            <p>质量检查只覆盖已记录信号，不代表结论已获业务验证。</p>
                            <dl>
                                <dt>时间范围</dt>
                                <dd>{{ formatRange(evidence[ref.artifactId]!.context.state.timeRange) }}</dd>
                                <dt>对比范围</dt>
                                <dd>{{ formatRange(evidence[ref.artifactId]!.context.state.comparisonRange) }}</dd>
                                <dt>筛选条件</dt>
                                <dd>{{ formatFilters(evidence[ref.artifactId]!.context.state.filters) }}</dd>
                                <dt>临时约定</dt>
                                <dd>{{ evidence[ref.artifactId]!.context.state.temporaryNotes.map((d) => `${d.name}：${d.description}`).join('；') || '无' }}</dd>
                            </dl>
                            <details v-for="memory in evidence[ref.artifactId]!.context.memories" :key="memory.id">
                                <summary>{{ memory.name }} · v{{ memory.version }}（查询时快照）</summary>
                                <MemoryContent :content="memory" />
                            </details>
                            <SqlBlock title="执行 SQL" :content="evidence[ref.artifactId]!.executedSql" />
                            <SqlBlock
                                v-if="evidence[ref.artifactId]!.originalSql !== evidence[ref.artifactId]!.executedSql"
                                title="原始 SQL"
                                :content="evidence[ref.artifactId]!.originalSql"
                            />
                            <div class="table-scroll">
                                <table>
                                    <thead>
                                        <tr>
                                            <th v-for="col in evidence[ref.artifactId]!.columns" :key="col.name">{{ col.name }}</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        <tr v-for="(row, i) in pages[ref.artifactId]?.rows" :key="i">
                                            <td v-for="col in evidence[ref.artifactId]!.columns" :key="col.name">{{ row[col.name] ?? '—' }}</td>
                                        </tr>
                                    </tbody>
                                </table>
                            </div>
                            <p v-if="pageErrors[ref.artifactId]" role="alert">{{ pageErrors[ref.artifactId] }}</p>
                            <button v-if="pages[ref.artifactId]?.nextCursor" :disabled="loading[ref.artifactId]" @click="loadPage(ref.artifactId, true)">下一页</button>
                            <button v-if="pageErrors[ref.artifactId]" :disabled="loading[ref.artifactId]" @click="loadPage(ref.artifactId, !!pages[ref.artifactId]?.nextCursor)">
                                重试读取结果
                            </button>
                        </template>
                    </details>
                </article>
            </section>
            <section v-if="extraCharts.length" class="report-section">
                <h3>补充图表</h3>
                <div v-for="chart in extraCharts" :key="chart.chartArtifactId || chart.title" class="finding-chart"><ChartBlock :chart-data="chart.chartData" /></div>
            </section>
            <div v-if="outcome.answer.limitations.length" class="report-notes">
                <h3>局限</h3>
                <ul>
                    <li v-for="item in outcome.answer.limitations" :key="item">{{ item }}</li>
                </ul>
            </div>
            <div v-if="outcome.answer.unresolvedQuestions.length" class="report-notes">
                <h3>待验证</h3>
                <ul>
                    <li v-for="item in outcome.answer.unresolvedQuestions" :key="item">{{ item }}</li>
                </ul>
            </div>
        </template>
        <MarkdownBlock
            :is-streaming="isStreaming"
            v-else-if="outcome.kind === 'clarification' || outcome.kind === 'refusal'"
            :content="outcome.kind === 'clarification' ? outcome.question : outcome.explanation"
        />
        <section v-if="!isStreaming">
            <p v-if="candidateError" role="alert">{{ candidateError }} <button @click="loadCandidates">刷新候选</button></p>
            <article v-for="candidate in candidates" :key="candidate.id">
                <h4>待保存记忆：{{ candidate.content.name }}</h4>
                <p>将写入数据源：{{ sourceName }}（{{ candidate.datasourceId }}）。保存后用于后续分析。</p>
                <p v-if="candidate.memoryId">修改已有记忆 v{{ candidate.expectedVersion }}；不会覆盖冲突版本。</p>
                <MemoryContent :content="candidate.content" />
                <button :disabled="busy" @click="decide(candidate, 'confirm')">保存到记忆</button>
                <button :disabled="busy" @click="decide(candidate, 'temporary')">仅本次使用</button>
                <button :disabled="busy" @click="decide(candidate, 'reject')">放弃保存</button>
                <p>“仅本次使用”会关闭保存候选，并发送临时约定请求；“放弃保存”不会撤销已经执行的查询。</p>
            </article>
        </section>
    </section>
</template>
<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { AnalysisEvidenceContext, ArtifactColumnV1, MemoryCandidate, ResultQualityV1 } from '@gist/contracts';
import type { AnalysisPresentation, MessageBlock } from '../../types';
import { apiFetch } from '../../api';
import { useChatStore } from '../../stores/chat';
import { useDataSourceStore } from '../../stores/datasource';
import { useAuthStore } from '../../stores/auth';
import MarkdownBlock from './MarkdownBlock.vue';
import ChartBlock from './ChartBlock.vue';
import AnalysisArtifactTable from './AnalysisArtifactTable.vue';
import SqlBlock from './SqlBlock.vue';
import MemoryContent from '../MemoryContent.vue';
function formatRange(range: AnalysisEvidenceContext['state']['timeRange']) {
    return range ? `${range.start} 至 ${range.endExclusive}（不含结束时间，${range.timezone}）` : '未设置';
}
function formatFilters(filters: AnalysisEvidenceContext['state']['filters']) {
    const operators = { eq: '等于', neq: '不等于', gt: '大于', gte: '大于等于', lt: '小于', lte: '小于等于', in: '属于' };
    return (
        filters.map((f) => `${f.field} ${operators[f.operator]} ${Array.isArray(f.value) ? f.value.join('、') : f.value === null ? '空值' : String(f.value)}`).join('；') || '无'
    );
}
const props = defineProps<{ analysis: AnalysisPresentation; charts?: MessageBlock[]; messageId: string; isStreaming: boolean }>();
const chat = useChatStore(),
    sources = useDataSourceStore(),
    auth = useAuthStore();
const outcome = computed(() => props.analysis.outcome);
const kinds = { observation: '观察发现', supported_explanation: '有验证证据的解释', hypothesis: '待验证假设' };
const roles = { observation: '观察依据', verification: '验证依据', comparison: '比较依据' };
function chartFor(id: string) {
    return (props.charts ?? []).find((chart) => chart.chartArtifactId === id);
}
const findings = computed(() => (outcome.value.kind === 'answer' || outcome.value.kind === 'partial' ? outcome.value.answer.findings : []));
const primaryChart = computed(() => {
    const charts = props.charts ?? [];
    const firstFinding = findings.value.find((finding) => finding.kind !== 'hypothesis' && finding.evidence.length);
    return charts.find((chart) => firstFinding?.evidence.some((ref) => ref.artifactId === chart.queryArtifactId)) ?? charts[0];
});
function chartFindingId(chart: MessageBlock) {
    return findings.value.find((finding) => finding.evidence.some((ref) => ref.artifactId === chart.queryArtifactId))?.id;
}
function chartsForFinding(finding: { id: string }) {
    return (props.charts ?? []).filter((chart) => chart !== primaryChart.value && chartFindingId(chart) === finding.id);
}
const extraCharts = computed(() => (props.charts ?? []).filter((chart) => chart !== primaryChart.value && !chartFindingId(chart)));
interface Evidence {
    purpose: string;
    expectedGrain: string;
    createdAt: string;
    returnedRowCount: number;
    isLimited: boolean;
    quality?: ResultQualityV1;
    context: AnalysisEvidenceContext;
    originalSql: string;
    executedSql: string;
    columns: ArtifactColumnV1[];
}
const evidence = ref<Record<string, Evidence>>({}),
    errors = ref<Record<string, string>>({}),
    pageErrors = ref<Record<string, string>>({}),
    loading = ref<Record<string, boolean>>({});
const pages = ref<Record<string, { rows: Record<string, unknown>[]; nextCursor: string | null }>>({});
async function request(url: string, body?: unknown) {
    const res = await apiFetch(url, body ? { method: 'POST', body: JSON.stringify(body) } : undefined);
    if (!res.ok) {
        const error = await res.json().catch(() => ({}));
        throw new Error(res.status === 409 ? '内容或权限已变化，请刷新后重新确认；证据需重新查询。' : error.message || '读取失败，请重试');
    }
    return res.json();
}
const path = (id: string) => `/analysis-artifacts/${encodeURIComponent(id)}`;
const query = () => `conversationId=${encodeURIComponent(props.analysis.state.conversationId)}`;
async function loadEvidence(id: string) {
    if (loading.value[id]) return;
    loading.value[id] = true;
    errors.value[id] = '';
    try {
        evidence.value[id] = await request(`${path(id)}?${query()}`);
        await loadPage(id);
    } catch (e) {
        errors.value[id] = (e as Error).message;
    } finally {
        loading.value[id] = false;
    }
}
async function loadPage(id: string, next = false) {
    loading.value[id] = true;
    pageErrors.value[id] = '';
    try {
        pages.value[id] = await request(`${path(id)}/rows?${query()}&limit=50${next ? `&cursor=${pages.value[id]?.nextCursor}` : ''}`);
    } catch (e) {
        pageErrors.value[id] = (e as Error).message;
    } finally {
        loading.value[id] = false;
    }
}
function openEvidence(event: Event, id: string) {
    if ((event.target as HTMLDetailsElement).open && !evidence.value[id]) void loadEvidence(id);
}
const candidates = ref<MemoryCandidate[]>([]),
    candidateError = ref(''),
    busy = ref(false);
const sourceName = computed(() => sources.list.find((s) => s.id === props.analysis.state.datasourceId)?.name || '当前数据源');
let epoch = 0;
async function loadCandidates() {
    const seq = ++epoch;
    candidates.value = [];
    candidateError.value = '';
    if (props.isStreaming) return;
    const state = props.analysis.state;
    if (sources.list.find((s) => s.id === state.datasourceId)?.created_by !== auth.user?.id) return;
    try {
        const pending: MemoryCandidate[] = await request(
            `/memory-candidates?datasourceId=${state.datasourceId}&conversationId=${encodeURIComponent(state.conversationId)}`
        );
        if (seq === epoch) candidates.value = pending.filter((c) => c.sourceMessageId === props.analysis.snapshot.requestMessageId);
    } catch (e) {
        if (seq === epoch) candidateError.value = (e as Error).message;
    }
}
async function decide(c: MemoryCandidate, action: 'confirm' | 'reject' | 'temporary') {
    busy.value = true;
    candidateError.value = '';
    try {
        if (action === 'temporary' && chat.activeGeneration) throw new Error('请等待当前分析结束后再使用临时约定');
        if (action === 'temporary' && chat.activeConversationId !== props.analysis.state.conversationId) throw new Error('请回到该会话后使用临时约定');
        await request(`/memory-candidates/${c.id}/${action === 'confirm' ? 'confirm' : 'reject'}`, { expectedVersion: c.version });
        candidates.value = candidates.value.filter((item) => item.id !== c.id);
        if (action === 'temporary') await chat.sendMessage(`仅在当前分析任务使用以下临时约定，不保存为长期定义。请更新分析条件并按需重新查询：\n${JSON.stringify(c.content)}`);
    } catch (e) {
        candidateError.value = (e as Error).message;
    } finally {
        busy.value = false;
    }
}
watch(
    () => [props.isStreaming, props.analysis, sources.list.length],
    () => void loadCandidates(),
    { immediate: true }
);
</script>
<style scoped>
.analysis-result {
    color: var(--da-text-main);
    line-height: 1.6;
    overflow-wrap: anywhere;
    max-width: 100%;
}
.result-tables {
    display: grid;
    gap: 14px;
}
.composed-result {
    display: grid;
    gap: 16px;
}
.missing-chart {
    margin: 0;
    color: var(--da-text-muted);
    font-size: 13px;
}
.table-note {
    margin: 10px 0 0;
    color: var(--da-text-muted);
    font-size: 12px;
}
.status {
    display: inline-flex;
    align-items: center;
    margin: 0 0 14px;
    padding: 4px 10px;
    border: 1px solid color-mix(in srgb, var(--status-info) 25%, transparent);
    border-radius: 999px;
    background: color-mix(in srgb, var(--status-info) 8%, transparent);
    color: var(--da-primary);
    font-size: 12px;
    font-weight: 600;
}
.status.partial {
    border-color: color-mix(in srgb, var(--status-warning) 30%, transparent);
    background: color-mix(in srgb, var(--status-warning) 9%, transparent);
    color: var(--status-warning);
}
.report-header {
    padding: 0 0 24px;
    border-bottom: 1px solid var(--da-border);
}
h2,
h3,
h4 {
    margin: 0;
    color: var(--da-text-main);
}
h2 {
    margin-bottom: 12px;
    font-size: 18px;
    letter-spacing: -0.02em;
}
h3 {
    margin-bottom: 16px;
    font-size: 15px;
    font-weight: 700;
}
.report-summary {
    font-size: 17px;
    font-weight: 600;
    line-height: 1.65;
}
.report-summary:deep(.markdown-block) {
    font-size: 17px;
    line-height: 1.65;
}
.key-points {
    display: grid;
    gap: 8px;
    margin: 16px 0 0;
    padding: 0;
    list-style: none;
}
.key-points li {
    position: relative;
    padding-left: 18px;
    color: var(--da-text-main);
    font-size: 14px;
}
.key-points li::before {
    content: '';
    position: absolute;
    left: 0;
    top: 0.72em;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--da-primary);
}
.partial-reason {
    margin: 16px 0 0;
    color: var(--status-warning);
    font-size: 13px;
}
.report-section {
    padding: 24px 0;
    border-bottom: 1px solid var(--da-border);
}
.metric-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
    gap: 12px;
}
.metric-card {
    display: flex;
    flex-direction: column;
    gap: 5px;
    min-width: 0;
    padding: 16px;
    border: 1px solid var(--da-border);
    border-radius: 12px;
    background: color-mix(in srgb, var(--da-text-muted) 4.5%, transparent);
}
.metric-label {
    color: var(--da-text-muted);
    font-size: 12px;
}
.metric-value {
    color: var(--da-text-main);
    font-size: clamp(19px, 2.4vw, 27px);
    line-height: 1.25;
    letter-spacing: -0.03em;
    font-variant-numeric: tabular-nums;
}
.metric-detail {
    color: var(--da-text-muted);
    font-size: 12px;
}
.featured-chart,
.finding-chart {
    margin-top: 16px;
    overflow: hidden;
    border: 1px solid var(--da-border);
    border-radius: 12px;
    background: color-mix(in srgb, var(--da-text-muted) 3.5000000000000004%, transparent);
}
.finding-card {
    padding: 17px 0;
    border-top: 1px solid var(--da-border);
}
.finding-card:first-of-type {
    padding-top: 0;
    border-top: 0;
}
.finding-heading {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 8px;
}
.finding-index {
    color: var(--da-text-muted);
    font-size: 12px;
    font-variant-numeric: tabular-nums;
}
.finding-kind {
    color: var(--da-primary);
    font-size: 12px;
    font-weight: 700;
}
.finding-kind.hypothesis {
    color: var(--status-warning);
}
.finding-text:deep(.markdown-block) {
    font-size: 14px;
    line-height: 1.7;
}
.report-notes {
    padding: 20px 0 0;
}
.report-notes h3 {
    margin-bottom: 8px;
}
.report-notes ul {
    margin: 0;
    padding-left: 20px;
    color: var(--da-text-muted);
    font-size: 13px;
}
.report-notes li + li {
    margin-top: 5px;
}
details {
    border: 1px solid var(--da-border);
    border-radius: 8px;
    padding: 10px 12px;
    margin: 12px 0 0;
    color: var(--da-text-muted);
    font-size: 12px;
}
details[open] {
    color: var(--da-text-main);
}
details summary {
    color: var(--da-text-muted);
    font-weight: 600;
}
summary,
button {
    cursor: pointer;
}
button {
    background: var(--da-bg);
    color: var(--da-text-main);
    border: 1px solid var(--da-border);
    padding: 8px 12px;
    margin: 5px 5px 5px 0;
    border-radius: 6px;
}
button:disabled {
    opacity: 0.5;
    cursor: default;
}
pre {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
}
.warning,
[role='alert'] {
    color: var(--status-warning);
}
dl {
    margin: 10px 0;
}
dt {
    color: var(--da-text-muted);
    font-size: 12px;
}
dd {
    margin: 0 0 8px;
}
.table-scroll {
    overflow: auto;
    max-height: 420px;
}
table {
    border-collapse: collapse;
    width: 100%;
}
td,
th {
    padding: 8px;
    border: 1px solid var(--da-border);
    text-align: left;
}
@media (max-width: 620px) {
    .metric-grid {
        grid-template-columns: repeat(2, minmax(0, 1fr));
    }
    .metric-card {
        padding: 12px;
    }
    .metric-value {
        font-size: 20px;
    }
}
</style>
