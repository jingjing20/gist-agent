<template>
  <div class="sql-block">
    <div class="sql-header" @click="isExpanded = !isExpanded" title="点击展开/收起">
      <div class="sql-title">
        <span class="toggle-icon">{{ isExpanded ? '▼' : '▶' }}</span>
        <span class="sql-label">SQL</span>
        <span v-if="!isExpanded" class="sql-hint">点击展开</span>
      </div>
      <button v-show="isExpanded" class="copy-btn" @click.stop="copySQL" :title="copied ? '已复制' : '复制'">
        {{ copied ? '已复制' : '复制' }}
      </button>
    </div>
    <div v-show="isExpanded" class="sql-content">
      <pre class="sql-code"><code v-html="highlightedSQL"></code></pre>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import hljs from 'highlight.js/lib/core';
import sql from 'highlight.js/lib/languages/sql';

hljs.registerLanguage('sql', sql);

const props = defineProps<{ content?: string }>();
const copied = ref(false);
const isExpanded = ref(false);

const highlightedSQL = computed(() => {
  if (!props.content) return '';
  return hljs.highlight(props.content, { language: 'sql' }).value;
});

function copySQL() {
  if (!props.content) return;
  navigator.clipboard.writeText(props.content);
  copied.value = true;
  setTimeout(() => { copied.value = false; }, 2000);
}
</script>

<style scoped>
.sql-block {
  background: var(--bg-code);
  border-radius: 8px;
  overflow: hidden;
  margin: 8px 0;
  border: 1px solid var(--border);
}

.sql-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 14px;
  background: var(--bg-code-header);
  cursor: pointer;
  user-select: none;
}

.sql-header:hover {
  background: var(--bg-hover);
}

.sql-title {
  display: flex;
  align-items: center;
  gap: 8px;
}

.toggle-icon {
  font-size: 10px;
  color: var(--text-secondary);
  transition: transform 0.2s;
}

.sql-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--accent);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.sql-hint {
  font-size: 12px;
  color: var(--text-secondary);
}

.copy-btn {
  background: none;
  border: 1px solid var(--border);
  color: var(--text-secondary);
  font-size: 12px;
  padding: 2px 10px;
  border-radius: 4px;
  cursor: pointer;
  transition: all 0.15s;
}

.copy-btn:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.sql-content {
  border-top: 1px solid var(--border);
}

.sql-code {
  padding: 14px;
  margin: 0;
  overflow-x: auto;
  font-size: 13px;
  line-height: 1.6;
  font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
}
</style>
