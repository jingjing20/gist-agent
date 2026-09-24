<template>
    <div v-if="renderedHTML" class="markdown-block" v-html="renderedHTML"></div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import MarkdownIt from 'markdown-it';

const markdown = new MarkdownIt({ html: false, linkify: true });

const props = defineProps<{ content?: string }>();

const renderedHTML = computed(() => {
    if (!props.content) return '';
    return markdown.render(props.content);
});
</script>

<style scoped>
.markdown-block {
    line-height: 1.7;
    color: var(--da-text-main);
    font-size: 14px;
    min-width: 0;
    overflow-x: auto;
}

.markdown-block :deep(p) {
    margin: 0 0 12px;
}

.markdown-block :deep(p:last-child) {
    margin-bottom: 0;
}

.markdown-block :deep(ul),
.markdown-block :deep(ol) {
    padding-left: 20px;
    margin: 12px 0;
}

.markdown-block :deep(li) {
    margin: 6px 0;
}

.markdown-block :deep(strong) {
    color: var(--da-text-main);
    font-weight: 700;
}

.markdown-block :deep(table) {
    width: 100%;
    min-width: 520px;
    margin: 12px 0;
    border: 1px solid var(--da-border);
    border-collapse: separate;
    border-spacing: 0;
    border-radius: 8px;
    background: var(--da-panel);
    font-size: 13px;
}

.markdown-block :deep(th),
.markdown-block :deep(td) {
    padding: 9px 12px;
    border-bottom: 1px solid var(--da-border);
    text-align: left;
    vertical-align: top;
}

.markdown-block :deep(th) {
    background: var(--da-card);
    font-weight: 600;
    white-space: nowrap;
}

.markdown-block :deep(tr:last-child td) {
    border-bottom: 0;
}

.markdown-block :deep(th + th),
.markdown-block :deep(td + td) {
    border-left: 1px solid var(--da-border);
}

.markdown-block :deep(tr:hover td) {
    background: var(--da-card);
}

.markdown-block :deep(code) {
    background: rgba(255, 255, 255, 0.08);
    padding: 2px 6px;
    border-radius: 4px;
    font-size: 13px;
    font-family: 'JetBrains Mono', 'SF Mono', monospace;
    color: var(--da-primary);
}
</style>
