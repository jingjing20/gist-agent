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
                    <template v-for="(block, i) in visibleBlocks" :key="i">
                        <component :is="hasAnalysis(block) ? AnalysisBlock : blockComponent(block.type)" v-bind="blockProps(block)" />
                    </template>
                    <p v-if="terminalStatus" role="status">{{ terminalStatus }}</p>
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
import { computed, type Component } from 'vue';
import AnalysisBlock from './blocks/AnalysisBlock.vue';
import SqlBlock from './blocks/SqlBlock.vue';
import TableBlock from './blocks/TableBlock.vue';
import MarkdownBlock from './blocks/MarkdownBlock.vue';
import LogBlock from './blocks/LogBlock.vue';
import ChartBlock from './blocks/ChartBlock.vue';
import type { MessageBlock, ChatMessage } from '../types';

const props = defineProps<{
    msg: ChatMessage;
    isStreaming: boolean;
}>();

const chat = useChatStore();
const terminalStatus = computed(() => {
    const status = Object.values(chat.generations).find((g) => g.messageId === props.msg.id)?.status;
    return status === 'cancelled' ? '分析已取消；已有内容不代表完整结论。' : status === 'failed' ? '分析未完成，请查看错误说明后重试。' : '';
});

// Raw model reasoning is not a product-facing protocol. Ignore legacy persisted
// blocks as well as preventing new ones from being rendered.
const visibleBlocks = computed(() => props.msg.blocks.filter((block) => block.type !== 'thinking' && block.type !== 'reasoning_chunk'));

const blockMap: Record<string, Component> = {
    sql: SqlBlock,
    table: TableBlock,
    text: MarkdownBlock,
    error: MarkdownBlock,
    log: LogBlock,
    chart: ChartBlock,
};

function hasAnalysis(block: MessageBlock): boolean {
    return !!(block.analysis?.state?.conversationId && block.analysis?.snapshot?.requestMessageId && block.analysis?.outcome);
}

function blockComponent(type: string): Component {
    return blockMap[type] || MarkdownBlock;
}

function blockProps(block: MessageBlock): Record<string, unknown> {
    if (hasAnalysis(block)) return { analysis: block.analysis, messageId: props.msg.id, isStreaming: props.isStreaming };
    if (block.type === 'log') {
        return {
            title: block.title,
            content: block.content,
            isLoading: props.isStreaming && String(block.content || '').startsWith('正在'),
        };
    }
    if (block.type === 'chart') {
        return { chartData: block.chartData };
    }
    return {
        title: block.title,
        content: block.type === 'error' ? `**错误:** ${block.content}` : block.content,
        columns: block.columns,
        rows: block.rows,
        rowCount: block.rowCount,
        isLimited: block.isLimited,
    };
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
    background: linear-gradient(135deg, var(--da-primary), #8b5cf6);
    border-radius: 8px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 12px;
    font-weight: 800;
    color: #fff;
    box-shadow: 0 4px 12px rgba(14, 165, 233, 0.2);
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
    color: #fff;
    border: none;
    max-width: 85%;
    text-align: left;
}

.assistant-content {
    display: flex;
    flex-direction: column;
    gap: 16px;
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
