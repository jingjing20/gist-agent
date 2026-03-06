<template>
  <div class="markdown-block" v-html="renderedHTML"></div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { marked } from 'marked';

const props = defineProps<{ content?: string }>();

const renderedHTML = computed(() => {
  if (!props.content) return '';
  return marked.parse(props.content, { async: false }) as string;
});
</script>

<style scoped>
.markdown-block {
  padding: 4px 0;
  line-height: 1.7;
  color: var(--text-primary);
  font-size: 14px;
}

.markdown-block :deep(p) {
  margin: 6px 0;
}

.markdown-block :deep(ul),
.markdown-block :deep(ol) {
  padding-left: 20px;
  margin: 6px 0;
}

.markdown-block :deep(li) {
  margin: 3px 0;
}

.markdown-block :deep(strong) {
  color: var(--text-primary);
  font-weight: 600;
}

.markdown-block :deep(code) {
  background: var(--bg-code);
  padding: 2px 6px;
  border-radius: 4px;
  font-size: 13px;
  font-family: 'SF Mono', 'Fira Code', monospace;
}
</style>
