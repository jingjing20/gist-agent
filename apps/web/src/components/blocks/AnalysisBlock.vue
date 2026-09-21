<template>
    <section class="analysis-result">
        <p class="status">
            {{
                outcome.kind === 'partial' ? '部分结果 · 仍有待查项' : outcome.kind === 'clarification' ? '需要补充信息' : outcome.kind === 'refusal' ? '本次无法分析' : '分析结果'
            }}
        </p>
        <template v-if="outcome.kind === 'answer' || outcome.kind === 'partial'">
            <MarkdownBlock :content="outcome.answer.summary" />
            <p v-if="outcome.kind === 'partial' && outcome.reason">{{ outcome.reason }}</p>
            <article v-for="finding in outcome.answer.findings" :key="finding.id">
                <small>{{ kinds[finding.kind] }}</small>
                <MarkdownBlock :content="finding.text" />
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
                            <dt>临时口径</dt>
                            <dd>{{ evidence[ref.artifactId]!.context.state.temporaryDefinitions.map((d) => `${d.name}：${d.description}`).join('；') || '无' }}</dd>
                        </dl>
                        <details v-for="definition in evidence[ref.artifactId]!.context.definitions" :key="definition.id">
                            <summary>{{ definition.name }} · v{{ definition.version }}（查询时快照）</summary>
                            <DefinitionContent :content="definition" />
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
            <div v-if="outcome.answer.limitations.length">
                <h4>限制说明</h4>
                <ul>
                    <li v-for="item in outcome.answer.limitations" :key="item">{{ item }}</li>
                </ul>
            </div>
            <div v-if="outcome.answer.unresolvedQuestions.length">
                <h4>仍待验证</h4>
                <ul>
                    <li v-for="item in outcome.answer.unresolvedQuestions" :key="item">{{ item }}</li>
                </ul>
            </div>
        </template>
        <MarkdownBlock v-else :content="outcome.kind === 'clarification' ? outcome.question : outcome.kind === 'refusal' ? outcome.explanation : ''" />
        <section v-if="!isStreaming">
            <p v-if="candidateError" role="alert">{{ candidateError }} <button @click="loadCandidates">刷新候选</button></p>
            <article v-for="candidate in candidates" :key="candidate.id">
                <h4>待保存：{{ candidate.content.name }}</h4>
                <p>将写入数据源：{{ sourceName }}（{{ candidate.datasourceId }}）。保存后用于后续分析。</p>
                <p v-if="candidate.definitionId">修改已有定义 v{{ candidate.expectedVersion }}；不会覆盖冲突版本。</p>
                <DefinitionContent :content="candidate.content" />
                <button :disabled="busy" @click="decide(candidate, 'confirm')">保存到业务定义</button>
                <button :disabled="busy" @click="decide(candidate, 'temporary')">仅本次使用</button>
                <button :disabled="busy" @click="decide(candidate, 'reject')">放弃保存</button>
                <p>“仅本次使用”会关闭保存候选，并发送临时口径请求；“放弃保存”不会撤销已经执行的查询。</p>
            </article>
        </section>
    </section>
</template>
<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { AnalysisEvidenceContext, ArtifactColumnV1, BusinessDefinitionCandidate, ResultQualityV1 } from '@gist/contracts';
import type { AnalysisPresentation } from '../../types';
import { apiFetch } from '../../api';
import { useChatStore } from '../../stores/chat';
import { useDataSourceStore } from '../../stores/datasource';
import { useAuthStore } from '../../stores/auth';
import MarkdownBlock from './MarkdownBlock.vue';
import SqlBlock from './SqlBlock.vue';
import DefinitionContent from '../DefinitionContent.vue';
function formatRange(range: AnalysisEvidenceContext['state']['timeRange']) {
    return range ? `${range.start} 至 ${range.endExclusive}（不含结束时间，${range.timezone}）` : '未设置';
}
function formatFilters(filters: AnalysisEvidenceContext['state']['filters']) {
    const operators = { eq: '等于', neq: '不等于', gt: '大于', gte: '大于等于', lt: '小于', lte: '小于等于', in: '属于' };
    return (
        filters.map((f) => `${f.field} ${operators[f.operator]} ${Array.isArray(f.value) ? f.value.join('、') : f.value === null ? '空值' : String(f.value)}`).join('；') || '无'
    );
}
const props = defineProps<{ analysis: AnalysisPresentation; messageId: string; isStreaming: boolean }>();
const chat = useChatStore(),
    sources = useDataSourceStore(),
    auth = useAuthStore();
const outcome = computed(() => props.analysis.outcome);
const kinds = { observation: '观察发现', supported_explanation: '有验证证据的解释', hypothesis: '待验证假设' };
const roles = { observation: '观察依据', verification: '验证依据', comparison: '比较依据' };
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
const candidates = ref<BusinessDefinitionCandidate[]>([]),
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
        const pending: BusinessDefinitionCandidate[] = await request(
            `/business-definition-candidates?datasourceId=${state.datasourceId}&conversationId=${encodeURIComponent(state.conversationId)}`
        );
        if (seq === epoch) candidates.value = pending.filter((c) => c.sourceMessageId === props.analysis.snapshot.requestMessageId);
    } catch (e) {
        if (seq === epoch) candidateError.value = (e as Error).message;
    }
}
async function decide(c: BusinessDefinitionCandidate, action: 'confirm' | 'reject' | 'temporary') {
    busy.value = true;
    candidateError.value = '';
    try {
        if (action === 'temporary' && chat.activeGeneration) throw new Error('请等待当前分析结束后再使用临时口径');
        if (action === 'temporary' && chat.activeConversationId !== props.analysis.state.conversationId) throw new Error('请回到该会话后使用临时口径');
        await request(`/business-definition-candidates/${c.id}/${action === 'confirm' ? 'confirm' : 'reject'}`, { expectedVersion: c.version });
        candidates.value = candidates.value.filter((item) => item.id !== c.id);
        if (action === 'temporary') await chat.sendMessage(`仅在当前分析任务使用以下临时业务口径，不保存为长期定义。请更新分析条件并按需重新查询：\n${JSON.stringify(c.content)}`);
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
    line-height: 1.7;
    overflow-wrap: anywhere;
}
.status,
small {
    color: var(--da-primary);
}
article,
details {
    border: 1px solid var(--da-border);
    border-radius: 8px;
    padding: 12px;
    margin: 10px 0;
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
    margin: 5px;
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
    color: #d97706;
}
dl {
    margin: 10px 0;
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
</style>
