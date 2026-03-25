<template>
  <div class="chat-detail">
    <template v-if="store.activeConversation">
      <div class="chat-header">
        <div class="header-left">
          <button v-if="sidebarCollapsed" class="toolbar-btn" @click="emit('open-sidebar')" title="展开侧边栏">
            <i class="fas fa-angle-double-right"></i>
          </button>
          <h2 class="chat-title">{{ store.activeConversation.title }}</h2>
        </div>
        <button v-if="!drawerOpen" class="toolbar-btn" @click="emit('toggle-drawer')" title="展开数据源上下文">
          <i class="fas fa-database text-da-primary"></i>
        </button>
      </div>
      <div class="message-list no-scrollbar" ref="messageListRef">
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

defineProps<{
  sidebarCollapsed?: boolean;
  drawerOpen?: boolean;
}>();

const emit = defineEmits<{
  (e: 'toggle-drawer'): void;
  (e: 'open-sidebar'): void;
}>();

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
  background: var(--da-bg);
  min-width: 0; /* needed for flex children truncation */
}

.chat-header {
  padding: 16px 24px;
  height: 48px;
  border-bottom: 1px solid rgba(51, 58, 77, 0.5); /* da-border/50 */
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-shrink: 0;
}

.header-left {
  display: flex;
  align-items: center;
  gap: 12px;
  overflow: hidden;
}

.chat-title {
  font-size: 16px;
  font-weight: 600;
  color: #fff;
  margin: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.toolbar-btn {
  background: none;
  border: none;
  color: var(--da-text-muted);
  font-size: 16px;
  cursor: pointer;
  transition: color 0.2s;
  padding: 4px;
}
.toolbar-btn:hover {
  color: #fff;
}

.message-list {
  flex: 1;
  overflow-y: auto;
  padding: 24px;
}

.no-scrollbar::-webkit-scrollbar {
  display: none;
}
.no-scrollbar {
  -ms-overflow-style: none;
  scrollbar-width: none;
}
</style>
