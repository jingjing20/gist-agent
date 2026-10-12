<template>
    <section v-if="hasVisibleContent" class="flex flex-col gap-3">
        <p v-if="showFollowup && outcome.status !== 'complete'" role="status" class="text-sm text-muted-foreground">{{ labels[outcome.status] }}：{{ outcome.reason }}</p>
        <ul v-if="showFollowup && outcome.missingItems.length" class="list-disc pl-5 text-sm text-muted-foreground">
            <li v-for="item in outcome.missingItems" :key="item">{{ item }}</li>
        </ul>
        <div v-for="(block, index) in outcome.blocks" :key="index" class="report-stream-block">
            <MarkdownBlock v-if="block.type === 'markdown'" :is-streaming="isStreaming" :content="block.content" />
            <ArtifactResult
                v-else-if="block.type === 'table'"
                :block="{ type: 'table', queryArtifactId: block.artifactId, title: block.title }"
                :conversation-id="analysis.state.conversationId"
            />
            <ArtifactResult v-else-if="chartFor(block.chartArtifactId)" :block="chartFor(block.chartArtifactId)!" :conversation-id="analysis.state.conversationId" />
        </div>
        <section v-if="showFollowup && usedMemories.length" class="flex flex-col gap-2 rounded-lg border border-border p-4" aria-label="本次采用的业务口径">
            <h4 class="text-sm font-medium">本次采用的业务口径</h4>
            <details v-for="memory in usedMemories" :key="`${memory.id}-${memory.version}`" class="text-sm">
                <summary>{{ memory.name }} · v{{ memory.version }}</summary>
                <MemoryContent :content="memory" />
            </details>
            <p class="text-xs text-muted-foreground">展示本次分析引用的版本，后续修改不会改变这里的历史内容。</p>
        </section>
        <section v-if="showFollowup">
            <p v-for="receipt in savedReceipts" :key="receipt.candidateId" role="status" class="text-sm">
                已保存并生效：“{{ receipt.name }}” · v{{ receipt.version }}。后续涉及此数据源的分析可采用该口径；本轮结果不会自动重算。
            </p>
            <p v-if="candidateError" role="alert">{{ candidateError }} <button @click="loadCandidates">刷新候选</button></p>
            <MemoryCandidateCard
                v-for="candidate in candidates"
                :key="candidate.id"
                :candidate="candidate"
                :source-name="sources.list.find((source) => source.id === candidate.datasourceId)?.name"
                :busy="busy"
                @saved="recordSaved(candidate, $event)"
                @reject="decide(candidate, 'reject')"
                @busy="busy = $event"
            >
                <Button variant="outline" :disabled="busy" @click="decide(candidate, 'temporary')">仅本次使用</Button>
            </MemoryCandidateCard>
            <p v-if="candidates.length" class="text-xs text-muted-foreground">“仅本次使用”会关闭候选并发送临时约定请求；放弃保存不会撤销已执行的查询。</p>
        </section>
    </section>
</template>
<script setup lang="ts">
import { computed, inject, ref, watch } from 'vue';
import type { MemoryCandidate } from '@gist/contracts';
import type { AnalysisPresentation, MessageBlock } from '../../types';
import { apiFetch } from '../../api';
import { useChatStore } from '../../stores/chat';
import { useDataSourceStore } from '../../stores/datasource';
import { useAuthStore } from '../../stores/auth';
import MarkdownBlock from './MarkdownBlock.vue';
import ArtifactResult from './ArtifactResult.vue';
import MemoryContent from '../MemoryContent.vue';
import MemoryCandidateCard from '../MemoryCandidateCard.vue';
import { textPlaybackKey } from '../../utils/text-playback';
import { Button } from '@/components/ui/button';
const props = defineProps<{ analysis: AnalysisPresentation; charts?: MessageBlock[]; messageId: string; isStreaming: boolean }>();
const chat = useChatStore(),
    sources = useDataSourceStore(),
    auth = useAuthStore();
const playback = inject(textPlaybackKey, undefined);
const showFollowup = computed(() => !props.isStreaming && !playback?.isPlaying?.value);
const savedReceipts = ref<{ candidateId: string; name: string; version: number }[]>([]);
function recordSaved(candidate: MemoryCandidate, result: { name: string; version: number }) {
    savedReceipts.value.push({ candidateId: candidate.id, ...result });
    void loadCandidates();
}
const outcome = computed(() => props.analysis.outcome);
const labels = { partial: '部分完成', awaiting_clarification: '需要补充信息', unable_to_complete: '本次无法完成' };
const usedMemories = computed(() =>
    (props.analysis.memories ?? []).filter((memory) => props.analysis.state.memoryRefs.some((ref) => ref.id === memory.id && ref.version === memory.version))
);
const hasVisibleContent = computed(
    () =>
        savedReceipts.value.length > 0 ||
        usedMemories.value.length > 0 ||
        outcome.value.blocks.length > 0 ||
        outcome.value.status !== 'complete' ||
        candidates.value.length > 0 ||
        !!candidateError.value
);
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
async function decide(c: MemoryCandidate, action: 'reject' | 'temporary') {
    busy.value = true;
    candidateError.value = '';
    try {
        if (action === 'temporary' && chat.activeGeneration) throw new Error('请等待当前分析结束后再使用临时约定');
        if (action === 'temporary' && chat.activeConversationId !== props.analysis.state.conversationId) throw new Error('请回到该会话后使用临时约定');
        await request(`/memory-candidates/${c.id}/reject`, { expectedVersion: c.version });
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
.report-stream-block:has([data-playing='true']) ~ .report-stream-block {
    display: none;
}
</style>
