<template>
  <div class="log-block">
    <div class="log-header" @click="collapsed = !collapsed">
      <span class="icon">⚙️</span>
      <span class="title">{{ title }}</span>
      <span class="toggle-icon">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" :style="{ transform: collapsed ? 'rotate(-90deg)' : 'rotate(0)' }">
          <path d="M6 9l6 6 6-6"/>
        </svg>
      </span>
    </div>
    <div v-show="!collapsed" class="log-content">
      <pre><code>{{ content }}</code></pre>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';

defineProps<{
  title?: string;
  content?: string;
}>();

const collapsed = ref(true);
</script>

<style scoped>
.log-block {
  margin: 12px 0;
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
  background: var(--bg-primary);
}

.log-header {
  display: flex;
  align-items: center;
  padding: 8px 12px;
  cursor: pointer;
  background: var(--bg-secondary);
  user-select: none;
}

.log-header:hover {
  background: var(--bg-hover);
}

.icon {
  margin-right: 8px;
  font-size: 14px;
}

.title {
  flex: 1;
  font-size: 13px;
  color: var(--text-secondary);
  font-weight: 500;
}

.toggle-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-secondary);
  transition: transform 0.2s;
}

.log-content {
  padding: 12px;
  border-top: 1px solid var(--border);
  background: var(--bg-code);
  font-size: 12px;
  color: var(--text-primary);
  overflow-x: auto;
}

.log-content pre {
  margin: 0;
  font-family: inherit;
  white-space: pre-wrap;
  word-wrap: break-word;
}
</style>
