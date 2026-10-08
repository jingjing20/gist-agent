<template>
    <div class="log-block" :class="{ 'is-loading': isLoading }">
        <div class="log-header" @click="collapsed = !collapsed">
            <div class="status-indicator">
                <i v-if="isLoading" class="fas fa-circle-notch fa-spin spinner"></i>
                <i v-else-if="isIncomplete" class="fas fa-exclamation-circle warning"></i>
                <i v-else class="fas fa-check-circle success"></i>
            </div>
            <span class="title">{{ title }}</span>
            <div class="header-right">
                <i class="fas fa-chevron-down toggle-icon" :class="{ 'is-flipped': !collapsed }" v-if="!isLoading"></i>
            </div>
        </div>
        <div v-show="!collapsed" class="log-content no-scrollbar">
            <pre><code>{{ content }}</code></pre>
        </div>
    </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';

const props = defineProps<{
    title?: string;
    content?: string;
    isLoading?: boolean;
    isIncomplete?: boolean;
}>();

const collapsed = ref(!/^分析步骤 \d+$/.test(props.title || ''));
</script>

<style scoped>
.log-block {
    border-radius: 10px;
    overflow: hidden;
    background: color-mix(in srgb, var(--foreground) 2%, transparent);
    border: 1px solid var(--da-border);
    transition: all 0.2s;
}

.log-block.is-loading {
    border-color: color-mix(in srgb, var(--status-info) 30%, transparent);
}

.log-header {
    display: flex;
    align-items: center;
    padding: 8px 14px;
    cursor: pointer;
    user-select: none;
    gap: 12px;
}

.log-header:hover {
    background: color-mix(in srgb, var(--foreground) 4%, transparent);
}

.status-indicator {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 20px;
}

.spinner {
    color: var(--da-primary);
    font-size: 14px;
}

.warning {
    color: var(--status-warning);
}

.success {
    color: var(--status-success); /* emerald-500 */
    font-size: 14px;
}

.title {
    flex: 1;
    font-size: 13px;
    color: var(--da-text-main);
    font-weight: 500;
}

.header-right {
    display: flex;
    align-items: center;
    gap: 8px;
}

.pulse-text {
    font-size: 11px;
    color: var(--da-primary);
    opacity: 0.8;
    animation: log-pulse 1.5s infinite;
}

@keyframes log-pulse {
    0%,
    100% {
        opacity: 0.4;
    }
    50% {
        opacity: 1;
    }
}

.toggle-icon {
    font-size: 12px;
    color: var(--da-text-muted);
    transition: transform 0.2s;
}

.toggle-icon.is-flipped {
    transform: rotate(180deg);
}

.log-content {
    padding: 12px 16px;
    border-top: 1px solid var(--da-border);
    background: var(--bg-code);
    font-size: 12px;
    color: var(--da-text-muted);
    overflow-x: auto;
}

.log-content pre {
    margin: 0;
    font-family: 'JetBrains Mono', monospace;
    white-space: pre-wrap;
    word-wrap: break-word;
    line-height: 1.5;
}

.no-scrollbar::-webkit-scrollbar {
    display: none;
}
.no-scrollbar {
    -ms-overflow-style: none;
    scrollbar-width: none;
}
</style>
