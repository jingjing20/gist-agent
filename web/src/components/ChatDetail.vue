<template>
  <div class="chat-detail">
    <template v-if="store.activeConversation">
      <div class="chat-header">
        <h2 class="chat-title">{{ store.activeConversation.title }}</h2>
      </div>
      <div class="message-list" ref="messageListRef">
        <ChatMessageItem
          v-for="msg in store.activeConversation.messages"
          :key="msg.id"
          :msg="msg"
          :isStreaming="store.isLoading && isLastAssistantMsg(msg)"
        />
      </div>
    </template>
    <template v-else>
      <ChatEmptyState @select="handleExample" />
    </template>
    <ChatInput />
  </div>
</template>

<script setup lang="ts">
import { watch, nextTick, ref } from 'vue';
import { useChatStore } from '../stores/chat';
import ChatInput from './ChatInput.vue';
import ChatEmptyState from './ChatEmptyState.vue';
import ChatMessageItem from './ChatMessageItem.vue';
import type { ChatMessage } from '../types';

const store = useChatStore();
const messageListRef = ref<HTMLElement>();

function isLastAssistantMsg(msg: ChatMessage): boolean {
  const msgs = store.activeConversation?.messages;
  if (!msgs) return false;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === 'assistant') return msgs[i].id === msg.id;
  }
  return false;
}

function scrollToBottom() {
  nextTick(() => {
    const el = messageListRef.value;
    if (el) el.scrollTop = el.scrollHeight;
  });
}

watch(() => store.activeConversation?.messages.length, scrollToBottom);

watch(
  () => {
    const conv = store.activeConversation;
    if (!conv) return 0;
    return conv.messages.reduce((n, m) => n + m.blocks.length, 0);
  },
  scrollToBottom,
);

async function handleExample(query: string) {
  store.startNewChat();
  store.sendMessage(query);
}
</script>

<style scoped>
.chat-detail {
  flex: 1;
  display: flex;
  flex-direction: column;
  height: 100%;
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
</style>
