<template>
  <div class="log-block" :class="{ 'is-loading': isLoading }">
    <div class="log-header" @click="collapsed = !collapsed">
      <div class="status-indicator">
        <i v-if="isLoading" class="fas fa-circle-notch fa-spin spinner"></i>
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

defineProps<{
  title?: string;
  content?: string;
  isLoading?: boolean;
}>();

const collapsed = ref(true);
</script>

<style scoped>
.log-block {
  border-radius: 10px;
  overflow: hidden;
  background: rgba(255, 255, 255, 0.02);
  border: 1px solid var(--da-border);
  transition: all 0.2s;
}

.log-block.is-loading {
  border-color: rgba(14, 165, 233, 0.3);
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
  background: rgba(255, 255, 255, 0.04);
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

.success {
  color: #10b981; /* emerald-500 */
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
  0%, 100% { opacity: 0.4; }
  50% { opacity: 1; }
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
  background: #0f172a;
  font-size: 12px;
  color: #94a3b8;
  overflow-x: auto;
}

.log-content pre {
  margin: 0;
  font-family: 'JetBrains Mono', monospace;
  white-space: pre-wrap;
  word-wrap: break-word;
  line-height: 1.5;
}

.no-scrollbar::-webkit-scrollbar { display: none; }
.no-scrollbar { -ms-overflow-style: none; scrollbar-width: none; }
</style>
