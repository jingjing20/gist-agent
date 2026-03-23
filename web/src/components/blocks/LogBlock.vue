<template>
  <div class="log-block">
    <div class="log-header" @click="collapsed = !collapsed">
      <span class="icon" v-if="!isLoading">⚙️</span>
      <svg v-else class="icon spinner" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <line x1="12" y1="2" x2="12" y2="6"></line>
        <line x1="12" y1="18" x2="12" y2="22"></line>
        <line x1="4.93" y1="4.93" x2="7.76" y2="7.76"></line>
        <line x1="16.24" y1="16.24" x2="19.07" y2="19.07"></line>
        <line x1="2" y1="12" x2="6" y2="12"></line>
        <line x1="18" y1="12" x2="22" y2="12"></line>
        <line x1="4.93" y1="19.07" x2="7.76" y2="16.24"></line>
        <line x1="16.24" y1="7.76" x2="19.07" y2="4.93"></line>
      </svg>
      <span class="title">{{ title }}</span>
      <span v-if="isLoading" class="loading-text">执行中...</span>
      <span class="toggle-icon">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" :style="{ transform: collapsed ? 'rotate(-90deg)' : 'rotate(0)' }" v-if="!isLoading">
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
  isLoading?: boolean;
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

.spinner {
  animation: log-spin 1s linear infinite;
  color: var(--accent);
}

.loading-text {
  font-size: 12px;
  color: var(--accent);
  margin-right: 8px;
  animation: log-pulse 1.5s infinite;
}

@keyframes log-spin {
  100% { transform: rotate(360deg); }
}

@keyframes log-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
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
