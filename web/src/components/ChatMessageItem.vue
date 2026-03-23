<template>
  <div class="message" :class="msg.role">
    <div class="message-avatar">
      {{ msg.role === 'user' ? 'U' : 'AI' }}
    </div>
    <div class="message-body">
      <template v-if="msg.role === 'user'">
        <div class="user-text">{{ msg.content }}</div>
      </template>
      <template v-else>
        <template v-for="(block, i) in msg.blocks" :key="i">
          <component
            v-if="block.type !== 'log'"
            :is="blockComponent(block.type)"
            v-bind="blockProps(block)"
          />
        </template>
        <div v-if="isStreaming" class="streaming-indicator">
          <span class="dot"></span>
          <span class="dot"></span>
          <span class="dot"></span>
        </div>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { type Component } from 'vue';
import ThinkingBlock from './blocks/ThinkingBlock.vue';
import SqlBlock from './blocks/SqlBlock.vue';
import TableBlock from './blocks/TableBlock.vue';
import MarkdownBlock from './blocks/MarkdownBlock.vue';
import LogBlock from './blocks/LogBlock.vue';
import ChartBlock from './blocks/ChartBlock.vue';
import type { MessageBlock, ChatMessage } from '../types';

const props = defineProps<{
  msg: ChatMessage;
  isStreaming: boolean;
}>();

const blockMap: Record<string, Component> = {
  thinking: ThinkingBlock,
  sql: SqlBlock,
  table: TableBlock,
  text: MarkdownBlock,
  error: MarkdownBlock,
  log: LogBlock,
  chart: ChartBlock,
};

function blockComponent(type: string): Component {
  return blockMap[type] || MarkdownBlock;
}

function blockProps(block: MessageBlock): Record<string, unknown> {
  if (block.type === 'log') {
    return { title: block.title, content: block.content };
  }
  if (block.type === 'chart') {
    return { chartData: block.chartData };
  }
  return {
    content: block.type === 'error' ? `**错误:** ${block.content}` : block.content,
    columns: block.columns,
    rows: block.rows,
    rowCount: block.rowCount,
  };
}
</script>

<style scoped>
.message {
  display: flex;
  gap: 14px;
  margin-bottom: 24px;
  max-width: 800px;
  margin-left: auto;
  margin-right: auto;
}

.message-avatar {
  width: 32px;
  height: 32px;
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  font-weight: 700;
  flex-shrink: 0;
  color: #fff;
}

.message.user .message-avatar {
  background: var(--accent);
}

.message.assistant .message-avatar {
  background: linear-gradient(135deg, #6366f1, #8b5cf6);
}

.message-body {
  flex: 1;
  min-width: 0;
}

.user-text {
  background: var(--bg-secondary);
  padding: 10px 16px;
  border-radius: 12px;
  border-top-left-radius: 4px;
  font-size: 14px;
  line-height: 1.6;
  color: var(--text-primary);
  display: inline-block;
}

.streaming-indicator {
  display: flex;
  gap: 4px;
  padding: 10px 0;
}

.streaming-indicator .dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent);
  animation: streaming-pulse 1.4s infinite ease-in-out;
}

.streaming-indicator .dot:nth-child(2) { animation-delay: 0.2s; }
.streaming-indicator .dot:nth-child(3) { animation-delay: 0.4s; }

@keyframes streaming-pulse {
  0%, 80%, 100% { opacity: 0.3; transform: scale(0.8); }
  40% { opacity: 1; transform: scale(1.1); }
}
</style>
