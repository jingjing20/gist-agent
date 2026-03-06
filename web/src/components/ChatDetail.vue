<template>
  <div class="chat-detail">
    <template v-if="store.activeConversation">
      <div class="chat-header">
        <h2 class="chat-title">{{ store.activeConversation.title }}</h2>
      </div>

      <div class="message-list" ref="messageListRef">
        <div
          v-for="msg in store.activeConversation.messages"
          :key="msg.id"
          class="message"
          :class="msg.role"
        >
          <div class="message-avatar">
            {{ msg.role === 'user' ? 'U' : 'AI' }}
          </div>
          <div class="message-body">
            <template v-if="msg.role === 'user'">
              <div class="user-text">{{ msg.content }}</div>
            </template>
            <template v-else>
              <component
                v-for="(block, i) in msg.blocks"
                :key="i"
                :is="blockComponent(block.type)"
                v-bind="blockProps(block)"
              />
              <div v-if="msg.blocks.length === 0 && store.isLoading" class="waiting">
                等待响应中...
              </div>
            </template>
          </div>
        </div>
      </div>
    </template>

    <template v-else>
      <div class="empty-state">
        <div class="empty-icon">?</div>
        <h2>数据分析 Agent</h2>
        <p>选择一个对话或新建对话开始分析</p>
        <div class="example-queries">
          <div class="example-title">试试这样问:</div>
          <button
            v-for="q in exampleQueries"
            :key="q"
            class="example-btn"
            @click="handleExample(q)"
          >
            {{ q }}
          </button>
        </div>
      </div>
    </template>

    <ChatInput />
  </div>
</template>

<script setup lang="ts">
import { watch, nextTick, ref, type Component } from 'vue';
import { useChatStore } from '../stores/chat';
import ChatInput from './ChatInput.vue';
import ThinkingBlock from './blocks/ThinkingBlock.vue';
import SqlBlock from './blocks/SqlBlock.vue';
import TableBlock from './blocks/TableBlock.vue';
import MarkdownBlock from './blocks/MarkdownBlock.vue';
import AuthBlock from './blocks/AuthBlock.vue';
import LogBlock from './blocks/LogBlock.vue';
import ChartBlock from './blocks/ChartBlock.vue';
import type { MessageBlock } from '../types';

const store = useChatStore();
const messageListRef = ref<HTMLElement>();

const blockMap: Record<string, Component> = {
  thinking: ThinkingBlock,
  sql: SqlBlock,
  table: TableBlock,
  text: MarkdownBlock,
  error: MarkdownBlock,
  need_auth: AuthBlock,
  log: LogBlock,
  chart: ChartBlock,
};

function blockComponent(type: string): Component {
  return blockMap[type] || MarkdownBlock;
}

function blockProps(block: MessageBlock): Record<string, unknown> {
  if (block.type === 'need_auth') {
    return {
      tables: block.tables,
      reason: block.reason,
    };
  }
  if (block.type === 'log') {
    return {
      title: block.title,
      content: block.content,
    };
  }
  if (block.type === 'chart') {
    return {
      chartData: block.chartData,
    };
  }
  return {
    content: block.type === 'error' ? `**错误:** ${block.content}` : block.content,
    columns: block.columns,
    rows: block.rows,
    rowCount: block.rowCount,
  };
}

const exampleQueries = [
  '帮我分析下近一月天河平台的日活趋势',
  '对比三个平台最近一周的新增用户数',
  '近 7 天用户行为类型分布是怎样的',
  '哪个平台的用户平均使用时长最长',
];

async function handleExample(query: string) {
  store.startNewChat();
  store.sendMessage(query);
}

// 自动滚动到底部
function scrollToBottom() {
  nextTick(() => {
    const el = messageListRef.value;
    if (el) el.scrollTop = el.scrollHeight;
  });
}

watch(
  () => store.activeConversation?.messages.length,
  scrollToBottom,
);

watch(
  () => {
    const conv = store.activeConversation;
    if (!conv) return 0;
    return conv.messages.reduce((n, m) => n + m.blocks.length, 0);
  },
  scrollToBottom,
);
</script>

<style scoped>
.chat-detail {
  flex: 1;
  display: flex;
  flex-direction: column;
  height: 100vh;
  overflow: hidden;
  background: var(--bg-primary);
}

.chat-header {
  padding: 16px 24px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}

.chat-title {
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0;
}

.message-list {
  flex: 1;
  overflow-y: auto;
  padding: 24px;
}

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

.waiting {
  color: var(--text-secondary);
  font-size: 13px;
  font-style: italic;
}

.empty-state {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  color: var(--text-secondary);
}

.empty-icon {
  width: 64px;
  height: 64px;
  border-radius: 16px;
  background: linear-gradient(135deg, var(--accent), #8b5cf6);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 28px;
  color: #fff;
  margin-bottom: 8px;
}

.empty-state h2 {
  font-size: 22px;
  color: var(--text-primary);
  margin: 0;
  font-weight: 600;
}

.empty-state p {
  margin: 0;
  font-size: 14px;
}

.example-queries {
  margin-top: 24px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  align-items: center;
}

.example-title {
  font-size: 13px;
  color: var(--text-secondary);
  margin-bottom: 4px;
}

.example-btn {
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  color: var(--text-primary);
  padding: 10px 20px;
  border-radius: 10px;
  font-size: 13px;
  cursor: pointer;
  transition: all 0.15s;
  max-width: 400px;
  width: 100%;
  text-align: left;
}

.example-btn:hover {
  background: var(--bg-hover);
  border-color: var(--accent);
}
</style>
