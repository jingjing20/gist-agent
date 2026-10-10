<template>
    <section v-if="hasVisibleContent" class="flex flex-col gap-3">
        <p v-if="outcome.status !== 'complete'" role="status" class="text-sm text-muted-foreground">{{ labels[outcome.status] }}：{{ outcome.reason }}</p>
        <ul v-if="outcome.missingItems.length" class="list-disc pl-5 text-sm text-muted-foreground">
            <li v-for="item in outcome.missingItems" :key="item">{{ item }}</li>
        </ul>
        <template v-for="(block, index) in outcome.blocks" :key="index">
            <MarkdownBlock v-if="block.type === 'markdown'" :is-streaming="isStreaming" :content="block.content" />
            <ArtifactResult
                v-else-if="block.type === 'table'"
                :block="{ type: 'table', queryArtifactId: block.artifactId, title: block.title }"
                :conversation-id="analysis.state.conversationId"
            />
            <ArtifactResult v-else-if="chartFor(block.chartArtifactId)" :block="chartFor(block.chartArtifactId)!" :conversation-id="analysis.state.conversationId" />
        </template>
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
import type { MemoryCandidate } from '@gist/contracts';
import type { AnalysisPresentation, MessageBlock } from '../../types';
import { apiFetch } from '../../api';
import { useChatStore } from '../../stores/chat';
import { useDataSourceStore } from '../../stores/datasource';
import { useAuthStore } from '../../stores/auth';
import MarkdownBlock from './MarkdownBlock.vue';
import ArtifactResult from './ArtifactResult.vue';
import MemoryContent from '../MemoryContent.vue';
const props = defineProps<{ analysis: AnalysisPresentation; charts?: MessageBlock[]; messageId: string; isStreaming: boolean }>();
const chat = useChatStore(),
    sources = useDataSourceStore(),
    auth = useAuthStore();
const outcome = computed(() => props.analysis.outcome);
const labels = { partial: '部分完成', awaiting_clarification: '需要补充信息', unable_to_complete: '本次无法完成' };
const hasVisibleContent = computed(() => outcome.value.blocks.length > 0 || outcome.value.status !== 'complete' || candidates.value.length > 0 || !!candidateError.value);
function chartFor(id: string) {
    return (props.charts ?? []).find((chart) => chart.chartArtifactId === id);
}
async function request(url: string, body?: unknown) {
    const res = await apiFetch(url, body ? { method: 'POST', body: JSON.stringify(body) } : undefined);
    if (!res.ok) {
        const error = await res.json().catch(() => ({}));
        throw new Error(res.status === 409 ? '内容或权限已变化，请刷新后重新确认；证据需重新查询。' : error.message || '读取失败，请重试');
    }
    return res.json();
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
        const pending: MemoryCandidate[] = await request(`/memory-candidates?datasourceId=${state.datasourceId}&conversationId=${encodeURIComponent(state.conversationId)}`);
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
