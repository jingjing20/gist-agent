<template>
  <div v-if="renderedHTML" class="markdown-block" v-html="renderedHTML"></div>
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
  line-height: 1.7;
  color: var(--da-text-main);
  font-size: 14px;
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
  color: #fff;
  font-weight: 700;
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
