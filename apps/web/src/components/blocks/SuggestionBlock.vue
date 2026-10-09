<template>
    <div v-if="items.length" class="suggestion-list" aria-label="推荐问题">
        <button v-for="item in items" :key="item.id" type="button" class="suggestion-item" :disabled="disabled" @click="select(item.text)">
            <span>{{ item.text }}</span>
            <ChevronRight :size="18" aria-hidden="true" />
        </button>
    </div>
</template>

<script setup lang="ts">
import { ChevronRight } from '@lucide/vue';
import type { SuggestionItem } from '@gist/contracts';

const props = defineProps<{ items: SuggestionItem[]; disabled: boolean }>();
const emit = defineEmits<{ select: [text: string] }>();

function select(text: string) {
    if (props.disabled || !text.trim()) return;
    emit('select', text);
}
</script>

<style scoped>
.suggestion-list {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 12px;
    margin-top: 20px;
}
.suggestion-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 20px;
    max-width: 100%;
    padding: 12px 18px;
    border: 1px solid var(--da-border);
    border-radius: 16px;
    background: var(--da-card);
    color: var(--da-text-main);
    text-align: left;
    font-size: 14px;
    line-height: 1.6;
    cursor: pointer;
    transition:
        border-color 0.2s,
        background 0.2s;
}
.suggestion-item span {
    overflow-wrap: anywhere;
}
.suggestion-item svg {
    flex-shrink: 0;
    color: var(--da-text-muted);
}
.suggestion-item:hover:not(:disabled) {
    border-color: var(--da-primary);
    background: color-mix(in srgb, var(--da-primary) 5%, var(--da-card));
}
.suggestion-item:focus-visible {
    outline: 2px solid var(--da-primary);
    outline-offset: 3px;
}
.suggestion-item:disabled {
    opacity: 0.5;
    cursor: default;
}
</style>
