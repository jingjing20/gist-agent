<template>
  <div class="sql-block">
    <div class="sql-header" @click="isExpanded = !isExpanded" title="点击展开/收起">
      <div class="sql-title">
        <i class="fas fa-terminal sql-type-icon"></i>
        <span class="sql-label">SQL 查询语句</span>
        <span v-if="!isExpanded" class="sql-hint">点击展开代码</span>
      </div>
      <div class="header-actions">
        <button v-show="isExpanded" class="action-btn" @click.stop="copySQL" :title="copied ? '已复制' : '复制'">
          <i class="fas" :class="copied ? 'fa-check' : 'fa-copy'"></i>
          {{ copied ? '已复制' : '复制' }}
        </button>
        <i class="fas fa-chevron-down toggle-icon" :class="{ 'is-flipped': isExpanded }"></i>
      </div>
    </div>
    <div v-show="isExpanded" class="sql-content">
      <pre class="sql-code no-scrollbar"><code v-html="highlightedSQL"></code></pre>
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
  background: var(--da-panel);
  border-radius: 12px;
  overflow: hidden;
  border: 1px solid var(--da-border);
  box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);
}

.sql-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 10px 16px;
  background: rgba(255, 255, 255, 0.02);
  cursor: pointer;
  user-select: none;
  transition: background 0.2s;
}

.sql-header:hover {
  background: rgba(255, 255, 255, 0.05);
}

.sql-title {
  display: flex;
  align-items: center;
  gap: 10px;
}

.sql-type-icon {
  font-size: 14px;
  color: var(--da-primary);
}

.sql-label {
  font-size: 13px;
  font-weight: 600;
  color: #fff;
}

.sql-hint {
  font-size: 12px;
  color: var(--da-text-muted);
  opacity: 0.7;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}

.action-btn {
  background: var(--da-card);
  border: 1px solid var(--da-border);
  color: var(--da-text-muted);
  font-size: 11px;
  padding: 4px 8px;
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.2s;
  display: flex;
  align-items: center;
  gap: 6px;
}

.action-btn:hover {
  background: var(--da-border);
  color: #fff;
}

.toggle-icon {
  font-size: 12px;
  color: var(--da-text-muted);
  transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1);
}

.toggle-icon.is-flipped {
  transform: rotate(180deg);
}

.sql-content {
  border-top: 1px solid var(--da-border);
  background: #0f172a; /* Slate-900 like standard code bg */
}

.sql-code {
  padding: 16px;
  margin: 0;
  overflow-x: auto;
  font-size: 13px;
  line-height: 1.6;
  font-family: 'JetBrains Mono', 'SF Mono', 'Fira Code', monospace;
  color: #e2e8f0;
}

.no-scrollbar::-webkit-scrollbar { display: none; }
.no-scrollbar { -ms-overflow-style: none; scrollbar-width: none; }
</style>
