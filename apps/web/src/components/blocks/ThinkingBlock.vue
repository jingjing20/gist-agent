<template>
    <div class="thinking-block">
        <button
            class="thinking-trigger"
            type="button"
            :aria-expanded="expanded"
            :aria-label="expanded ? '收起思考过程' : '展开思考过程'"
            @click="expanded = !expanded"
        >
            <span v-if="isStreaming" class="thinking-indicator" aria-hidden="true">
                <span class="dot"></span>
                <span class="dot"></span>
                <span class="dot"></span>
            </span>
            <i v-else class="fas fa-chevron-right thinking-chevron" :class="{ expanded }" aria-hidden="true"></i>
            <span>{{ isStreaming ? '正在思考' : '思考过程' }}</span>
        </button>
        <div v-show="expanded" class="thinking-content">
            <MarkdownBlock :content="content || '思考中...'" />
        </div>
    </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import MarkdownBlock from './MarkdownBlock.vue';
import { initialThinkingExpanded } from './thinking-state';

const props = defineProps<{ content?: string; isStreaming?: boolean }>();
const expanded = ref(initialThinkingExpanded(Boolean(props.isStreaming)));
</script>

<style scoped>
.thinking-block {
    border-left: 2px solid rgba(14, 165, 233, 0.24);
    color: var(--da-text-muted);
    font-size: 13px;
}

.thinking-trigger {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 4px 10px;
    border: 0;
    border-radius: 7px;
    background: transparent;
    color: var(--da-text-muted);
    font: inherit;
    cursor: pointer;
}

.thinking-trigger:hover {
    background: rgba(255, 255, 255, 0.04);
    color: var(--da-text-main);
}

.thinking-trigger:focus-visible {
    outline: 2px solid var(--da-primary);
    outline-offset: 2px;
}

.thinking-indicator {
    display: flex;
    gap: 4px;
}

.dot {
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: var(--da-primary);
    animation: pulse 1.4s infinite ease-in-out;
    opacity: 0.6;
}

.dot:nth-child(2) {
    animation-delay: 0.2s;
}
.dot:nth-child(3) {
    animation-delay: 0.4s;
}

@keyframes pulse {
    0%,
    80%,
    100% {
        opacity: 0.4;
        transform: scale(0.8);
    }
    40% {
        opacity: 1;
        transform: scale(1.1);
    }
}

.thinking-chevron {
    width: 14px;
    font-size: 11px;
    text-align: center;
    transition: transform 160ms ease;
}

.thinking-chevron.expanded {
    transform: rotate(90deg);
}

.thinking-content {
    padding: 10px 12px 2px;
}

.thinking-content :deep(.markdown-block) {
    color: var(--da-text-muted);
    font-size: 13px;
}
</style>
