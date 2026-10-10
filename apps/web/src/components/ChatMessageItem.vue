<template>
    <div class="message" :class="msg.role">
        <div class="message-avatar">
            <i v-if="msg.role === 'user'" class="fas fa-user-circle"></i>
            <div v-else class="ai-avatar">DA</div>
        </div>
        <div class="message-body">
            <template v-if="msg.role === 'user'">
                <div class="user-text-container">
                    <div class="user-text">{{ msg.content }}</div>
                </div>
            </template>
            <template v-else>
                <div class="assistant-content">
                    <AnalysisProcessBlock v-if="hasAnalysisProcess" :blocks="msg.blocks" :is-streaming="isStreaming" :terminal-status="processTerminalStatus" />
                    <template v-for="(block, i) in visibleBlocks" :key="i">
                        <component
                            :is="block.analysis ? AnalysisBlock : block.type === 'chart' || block.type === 'table' ? ArtifactResult : blockComponent(block.type)"
                            v-bind="blockProps(block)"
                            @select="sendSuggestion"
                        />
                    </template>
                    <p v-if="terminalStatus" role="status">{{ terminalStatus }}</p>
                    <div v-if="canResume" class="terminal-actions">
                        <button type="button" :disabled="actionBusy" @click="restartAnalysis">重试原问题</button>
                    </div>
                    <div v-if="isStreaming" class="streaming-indicator">
                        <span class="dot"></span>
                        <span class="dot"></span>
                        <span class="dot"></span>
                    </div>
                </div>
            </template>
        </div>
    </div>
</template>

<script setup lang="ts">
import { useChatStore } from '../stores/chat';
import { computed, provide, ref, type Component } from 'vue';
import { textPlaybackKey } from '../utils/text-playback';
import AnalysisBlock from './blocks/AnalysisBlock.vue';
import ArtifactResult from './blocks/ArtifactResult.vue';
import AnalysisProcessBlock from './blocks/AnalysisProcessBlock.vue';
import SqlBlock from './blocks/SqlBlock.vue';
import TableBlock from './blocks/TableBlock.vue';
import MarkdownBlock from './blocks/MarkdownBlock.vue';
import LogBlock from './blocks/LogBlock.vue';
import ChartBlock from './blocks/ChartBlock.vue';
import SuggestionBlock from './blocks/SuggestionBlock.vue';
import type { MessageBlock, ChatMessage } from '../types';

const props = defineProps<{
    msg: ChatMessage;
    isStreaming: boolean;
}>();

const chat = useChatStore();
const playingRenderers = new Set<symbol>();
const playingTextCount = ref(0);
provide(textPlaybackKey, {
    setPlaying(token, playing) {
        if (playing) playingRenderers.add(token);
        else playingRenderers.delete(token);
        playingTextCount.value = playingRenderers.size;
    },
});
const generationStatus = computed(() => Object.values(chat.generations).find((g) => g.messageId === props.msg.id)?.status);
const processTerminalStatus = computed(() => {
    const status = generationStatus.value;
    return status === 'failed' || status === 'cancelled' || status === 'completed' ? status : undefined;
});
const actionBusy = ref(false);
const suggestionSending = ref(false);
const isLatestMessage = computed(() => chat.activeConversation?.messages.at(-1)?.id === props.msg.id);
const generationId = computed(() => Object.values(chat.generations).find((g) => g.messageId === props.msg.id)?.id);
const canResume = computed(() => !!generationId.value && (generationStatus.value === 'failed' || generationStatus.value === 'cancelled'));
const terminalStatus = computed(() => {
    const status = generationStatus.value;
    return status === 'cancelled' ? '分析已取消；已有内容不代表完整结论。' : status === 'failed' ? '分析未完成。上方显示失败原因，可重试原问题。' : '';
});

// Raw model reasoning is not a product-facing protocol.
const analysisWorkflow = computed(() =>
    props.msg.blocks.some((block) => (block.type === 'analysis_activity' && !!block.activity) || (block.type === 'log' && /^分析步骤 \d+$/.test(block.title || '')))
);
const hasAnalysisProcess = computed(() => analysisWorkflow.value);
const hasAnalysisResult = computed(() => props.msg.blocks.some((block) => !!block.analysis));
const reportCharts = computed(() => props.msg.blocks.filter((block) => block.type === 'chart' && !!block.chartData));
const visibleBlocks = computed(() =>
    props.msg.blocks.filter((block) => {
        if (block.type === 'suggestions')
            return isLatestMessage.value && !props.isStreaming && !props.msg.animateText && playingTextCount.value === 0 && generationStatus.value === 'completed';
        if (block.type === 'thinking' || block.type === 'reasoning_chunk') return false;
        if (analysisWorkflow.value && ['analysis_activity', 'log', 'sql', 'table'].includes(block.type) && !block.display) return false;
        if (hasAnalysisResult.value && block.type === 'table' && !block.display) return false;
        if (
            hasAnalysisResult.value &&
            block.type === 'chart' &&
            block.chartData &&
            props.msg.blocks.some((b) => b.analysis && !(b.analysis.outcome.kind === 'response' && b.analysis.outcome.blocks.length === 0))
        )
            return false;
        return true;
    })
);

const blockMap: Record<string, Component> = {
    sql: SqlBlock,
    table: TableBlock,
    text: MarkdownBlock,
    error: MarkdownBlock,
    log: LogBlock,
    chart: ChartBlock,
    suggestions: SuggestionBlock,
};

function blockComponent(type: string): Component {
    return blockMap[type] || MarkdownBlock;
}

function blockProps(block: MessageBlock): Record<string, unknown> {
    if (block.type === 'suggestions') return { items: block.items || [], disabled: chat.isLoading || suggestionSending.value };
    if (block.type === 'chart' || block.type === 'table') return { block, conversationId: block.conversationId || chat.activeConversationId };
    if (block.analysis) return { analysis: block.analysis, charts: reportCharts.value, messageId: props.msg.id, isStreaming: props.isStreaming || !!props.msg.animateText };
    if (block.type === 'log') {
        return {
            title: block.title,
            content: block.content,
            isLoading: props.isStreaming && String(block.content || '').startsWith('正在'),
            isIncomplete: /^(需要调整|未完成|已取消)/.test(block.content || '') || (!props.isStreaming && String(block.content || '').startsWith('正在')),
        };
    }
    return {
        isStreaming: block.type === 'text' && (props.isStreaming || !!props.msg.animateText),
        title: block.title,
        content: block.type === 'error' ? `**错误:** ${block.content}` : block.content,
        columns: block.columns,
        rows: block.rows,
        rowCount: block.rowCount,
        isLimited: block.isLimited,
    };
}

async function sendSuggestion(text: string) {
    if (suggestionSending.value || chat.isLoading || !isLatestMessage.value || !text.trim()) return;
    suggestionSending.value = true;
    try {
        await chat.sendMessage(text);
    } finally {
        suggestionSending.value = false;
    }
}

async function restartAnalysis() {
    if (!generationId.value) return;
    actionBusy.value = true;
    try {
        await chat.retryGeneration(generationId.value);
    } finally {
        actionBusy.value = false;
    }
}
</script>

<style scoped>
.message {
    display: flex;
    gap: 16px;
    margin-bottom: 32px;
    max-width: 900px;
    margin-left: auto;
    margin-right: auto;
    width: 100%;
}

.message.user {
    flex-direction: row-reverse;
}

.message-avatar {
    width: 36px;
    height: 36px;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
}

.message-avatar i {
    font-size: 32px;
    color: var(--da-text-muted);
}

.ai-avatar {
    width: 32px;
    height: 32px;
    background: linear-gradient(135deg, var(--da-primary), var(--da-gradient-start));
    border-radius: 8px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 12px;
    font-weight: 800;
    color: var(--primary-foreground);
    box-shadow: 0 4px 12px color-mix(in srgb, var(--status-info) 20%, transparent);
}

.message-body {
    flex: 1;
    min-width: 0;
}

.user-text-container {
    display: flex;
    justify-content: flex-end;
}

.user-text {
    background: var(--da-primary);
    padding: 12px 16px;
    border-radius: 12px;
    border-top-right-radius: 4px;
    font-size: 14px;
    line-height: 1.6;
    color: var(--primary-foreground);
    border: none;
    max-width: 85%;
    text-align: left;
}

.assistant-content {
    display: flex;
    flex-direction: column;
    gap: 16px;
}

.terminal-actions {
    display: flex;
    gap: 8px;
}

.terminal-actions button {
    border: 1px solid var(--da-border);
    border-radius: 7px;
    padding: 7px 11px;
    background: color-mix(in srgb, var(--da-text-muted) 8%, transparent);
    color: var(--da-text-main);
    cursor: pointer;
}

.terminal-actions button:hover:not(:disabled) {
    border-color: var(--da-primary);
}

.terminal-actions button:disabled {
    opacity: 0.5;
    cursor: default;
}

.streaming-indicator {
    display: flex;
    gap: 6px;
    padding: 8px 0;
}

.streaming-indicator .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--da-primary);
    animation: streaming-pulse 1.4s infinite ease-in-out;
    opacity: 0.6;
}

.streaming-indicator .dot:nth-child(2) {
    animation-delay: 0.2s;
}
.streaming-indicator .dot:nth-child(3) {
    animation-delay: 0.4s;
}

@keyframes streaming-pulse {
    0%,
    80%,
    100% {
        opacity: 0.3;
        transform: scale(0.8);
    }
    40% {
        opacity: 1;
        transform: scale(1.1);
    }
}
</style>
