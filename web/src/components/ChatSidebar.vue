<template>
  <aside class="sidebar">
    <div class="sidebar-header">
      <h1 class="logo">Data Agent</h1>
      <button class="new-chat-btn" @click="store.startNewChat()">
        <span class="icon">+</span>
        新建对话
      </button>
    </div>

    <div class="conversation-list">
      <div
        v-for="conv in store.conversations"
        :key="conv.id"
        class="conversation-item"
        :class="{ active: conv.id === store.activeConversationId }"
        @click="store.selectConversation(conv.id)"
      >
        <span class="conv-title">{{ conv.title }}</span>
        <button
          class="delete-btn"
          @click.stop="store.deleteConversation(conv.id)"
          title="删除"
        >
          x
        </button>
      </div>

      <div v-if="store.conversations.length === 0" class="empty-hint">
        暂无对话记录
      </div>
    </div>
  </aside>
</template>

<script setup lang="ts">
import { onMounted } from 'vue';
import { useChatStore } from '../stores/chat';

const store = useChatStore();

onMounted(() => {
  store.fetchConversations();
});
</script>

<style scoped>
.sidebar {
  width: 260px;
  min-width: 260px;
  height: 100vh;
  background: var(--bg-sidebar);
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.sidebar-header {
  padding: 20px 16px 16px;
  border-bottom: 1px solid var(--border);
}

.logo {
  font-size: 18px;
  font-weight: 700;
  color: var(--text-primary);
  margin: 0 0 14px 0;
  letter-spacing: -0.3px;
}

.new-chat-btn {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  background: var(--accent);
  color: #fff;
  border: none;
  border-radius: 8px;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: background 0.15s;
}

.new-chat-btn:hover {
  background: var(--accent-hover);
}

.icon {
  font-size: 18px;
  font-weight: 300;
}

.conversation-list {
  flex: 1;
  overflow-y: auto;
  padding: 8px;
}

.conversation-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  border-radius: 8px;
  cursor: pointer;
  transition: background 0.12s;
  margin-bottom: 2px;
}

.conversation-item:hover {
  background: var(--bg-hover);
}

.conversation-item.active {
  background: var(--bg-active);
}

.conv-title {
  font-size: 13px;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  min-width: 0;
}

.delete-btn {
  display: none;
  background: none;
  border: none;
  color: var(--text-secondary);
  font-size: 14px;
  cursor: pointer;
  padding: 2px 6px;
  border-radius: 4px;
  flex-shrink: 0;
}

.conversation-item:hover .delete-btn {
  display: block;
}

.delete-btn:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.empty-hint {
  text-align: center;
  color: var(--text-secondary);
  font-size: 13px;
  padding: 40px 0;
}
</style>
