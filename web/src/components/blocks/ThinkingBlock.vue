<template>
  <div class="thinking-block">
    <div class="thinking-indicator">
      <span class="dot"></span>
      <span class="dot"></span>
      <span class="dot"></span>
    </div>
    <span class="thinking-text">{{ content || "思考中..." }}</span>
  </div>
</template>

<script setup lang="ts">
defineProps<{ content?: string }>();
</script>

<style scoped>
.thinking-block {
  display: flex;
  align-items: center;
  gap: 12px;
  color: var(--da-text-muted);
  font-size: 13px;
}

.thinking-indicator {
  display: flex;
  gap: 6px;
}

.dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--da-primary);
  animation: pulse 1.4s infinite ease-in-out;
  opacity: 0.6;
}

.dot:nth-child(2) {
  animation-delay: 0.2s;
}
.dot:nth-child(3) {
  animation-delay: 0.4s;
}

@keyframes pulse {
  0%,
  80%,
  100% {
    opacity: 0.4;
    transform: scale(0.8);
  }
  40% {
    opacity: 1;
    transform: scale(1.1);
  }
}

.thinking-text {
  font-weight: 400;
  letter-spacing: 0.01em;
}
</style>
