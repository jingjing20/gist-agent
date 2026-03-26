<template>
  <aside class="sidebar" :class="{ 'is-collapsed': collapsed }">
    <div class="sidebar-header">
      <button class="new-chat-btn" @click="store.startNewChat()">
        <i class="fas fa-plus"></i>
        <span>新建对话</span>
      </button>
      <button class="collapse-btn" @click="emit('collapse')" title="收起侧边栏">
        <i class="fas fa-angle-double-left"></i>
      </button>
    </div>

    <div class="conversation-list no-scrollbar">
      <div
        v-for="conv in store.conversations"
        :key="conv.id"
        class="conversation-item"
        :class="{ active: conv.id === store.activeConversationId }"
        @click="store.selectConversation(conv.id)"
      >
        <div class="active-indicator" v-if="conv.id === store.activeConversationId"></div>
        <span class="conv-title" :title="conv.title">{{ conv.title }}</span>
        <div class="conv-actions">
          <button
            class="action-btn delete-btn"
            @click.stop="confirmDeleteConv(conv.id)"
            title="删除"
          >
            <i class="fas fa-trash-alt"></i>
          </button>
        </div>
      </div>

      <div v-if="store.conversations.length === 0" class="empty-hint">
        暂无对话记录
      </div>
    </div>

    <ConfirmModal
      :modelValue="!!deletingConvId"
      @update:modelValue="deletingConvId = null"
      title="确认删除对话"
      desc="确定要删除此对话吗？历史记录将无法恢复。"
      confirmText="删除"
      @confirm="executeDelete"
    />
  </aside>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useChatStore } from '../stores/chat';
import { useToastStore } from '../stores/toast';
import ConfirmModal from './ConfirmModal.vue';

defineProps<{
  collapsed: boolean;
}>();

const emit = defineEmits<{
  (e: 'collapse'): void;
}>();

const store = useChatStore();
const toast = useToastStore();
const deletingConvId = ref<string | null>(null);

function confirmDeleteConv(id: string) {
  deletingConvId.value = id;
}

async function executeDelete() {
  if (deletingConvId.value) {
    try {
      await store.deleteConversation(deletingConvId.value);
      toast.success('对话已删除');
    } catch (e: any) {
      toast.error('删除对话失败: ' + e.message);
    }
    deletingConvId.value = null;
  }
}

onMounted(() => {
  store.fetchConversations();
});
</script>

<style scoped>
.sidebar {
  width: 260px;
  min-width: 260px;
  height: 100%;
  background: var(--da-panel);
  backdrop-filter: blur(12px);
  border-right: 1px solid var(--da-border);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  flex-shrink: 0;
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
}

.sidebar.is-collapsed {
  margin-left: -260px;
  opacity: 0;
  pointer-events: none;
}

.sidebar-header {
  padding: 16px;
  border-bottom: 1px solid var(--da-border);
  display: flex;
  gap: 10px;
}

.new-chat-btn {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 10px 16px;
  background: var(--da-card);
  color: var(--da-text-main);
  border: 1px solid var(--da-border);
  border-radius: 10px;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s;
}

.new-chat-btn:hover {
  background: var(--da-border);
  border-color: var(--da-primary);
}

.collapse-btn {
  width: 42px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--da-card);
  color: var(--da-text-muted);
  border: 1px solid var(--da-border);
  border-radius: 10px;
  cursor: pointer;
  transition: all 0.2s;
}

.collapse-btn:hover {
  background: var(--da-border);
  color: var(--da-text-main);
}

.conversation-list {
  flex: 1;
  overflow-y: auto;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.conversation-item {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  border-radius: 10px;
  cursor: pointer;
  transition: all 0.2s;
  background: transparent;
  border: 1px solid transparent;
}

.conversation-item:hover {
  background: rgba(255, 255, 255, 0.03);
  border-color: var(--da-border);
}

.conversation-item.active {
  background: rgba(14, 165, 233, 0.1);
  border-color: rgba(14, 165, 233, 0.2);
}

.active-indicator {
  position: absolute;
  left: 0;
  top: 10px;
  bottom: 10px;
  width: 3px;
  background: var(--da-primary);
  border-radius: 0 4px 4px 0;
  box-shadow: 0 0 10px var(--da-primary);
}

.conv-title {
  font-size: 13px;
  color: var(--da-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  min-width: 0;
  transition: color 0.2s;
}

.conversation-item:hover .conv-title {
  color: var(--da-text-main);
}

.active .conv-title {
  color: #fff;
  font-weight: 500;
}

.conv-actions {
  display: flex;
  align-items: center;
  gap: 4px;
}

.delete-btn {
  background: none;
  border: none;
  color: var(--da-text-muted);
  cursor: pointer;
  opacity: 0;
  transition: all 0.2s;
  padding: 4px;
  border-radius: 4px;
}

.conversation-item:hover .delete-btn {
  opacity: 1;
}

.delete-btn:hover {
  background: rgba(239, 68, 68, 0.15);
  color: #ef4444;
}

.empty-hint {
  text-align: center;
  color: var(--da-text-muted);
  font-size: 13px;
  padding: 60px 0;
  font-style: italic;
}

.no-scrollbar::-webkit-scrollbar { display: none; }
.no-scrollbar { -ms-overflow-style: none; scrollbar-width: none; }
</style>
