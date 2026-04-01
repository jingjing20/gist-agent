<template>
  <div class="message" :class="msg.role">
    <div class="message-avatar">
      <i v-if="msg.role === 'user'" class="fas fa-user-circle"></i>
      <div v-else class="ai-avatar">DA</div>
    </div>
    <div class="message-body">
      <template v-if="msg.role === 'user'">
        <div class="user-text-container">
          <div class="user-text">{{ msg.content }}</div>
        </div>
      </template>
      <template v-else>
        <div class="assistant-content">
          <template v-for="(block, i) in msg.blocks" :key="i">
            <component
              :is="blockComponent(block.type)"
              v-bind="blockProps(block, i)"
            />
          </template>
          <div v-if="isStreaming" class="streaming-indicator">
            <span class="dot"></span>
            <span class="dot"></span>
            <span class="dot"></span>
          </div>
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

function blockProps(block: MessageBlock, index: number = -1): Record<string, unknown> {
  if (block.type === 'log') {
    const isLast = props.msg.blocks && index === props.msg.blocks.length - 1;
    return { 
      title: block.title, 
      content: block.content,
      isLoading: props.isStreaming && isLast
    };
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
  gap: 16px;
  margin-bottom: 32px;
  max-width: 900px;
  margin-left: auto;
  margin-right: auto;
  width: 100%;
}

.message.user {
  flex-direction: row-reverse;
}

.message-avatar {
  width: 36px;
  height: 36px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.message-avatar i {
  font-size: 32px;
  color: var(--da-text-muted);
}

.ai-avatar {
  width: 32px;
  height: 32px;
  background: linear-gradient(135deg, var(--da-primary), #8b5cf6);
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  font-weight: 800;
  color: #fff;
  box-shadow: 0 4px 12px rgba(14, 165, 233, 0.2);
}

.message-body {
  flex: 1;
  min-width: 0;
}

.user-text-container {
  display: flex;
  justify-content: flex-end;
}

.user-text {
  background: var(--da-primary);
  padding: 12px 16px;
  border-radius: 12px;
  border-top-right-radius: 4px;
  font-size: 14px;
  line-height: 1.6;
  color: #fff;
  border: none;
  max-width: 85%;
  text-align: left;
}

.assistant-content {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.streaming-indicator {
  display: flex;
  gap: 6px;
  padding: 8px 0;
}

.streaming-indicator .dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--da-primary);
  animation: streaming-pulse 1.4s infinite ease-in-out;
  opacity: 0.6;
}

.streaming-indicator .dot:nth-child(2) { animation-delay: 0.2s; }
.streaming-indicator .dot:nth-child(3) { animation-delay: 0.4s; }

@keyframes streaming-pulse {
  0%, 80%, 100% { opacity: 0.3; transform: scale(0.8); }
  40% { opacity: 1; transform: scale(1.1); }
}
</style>
