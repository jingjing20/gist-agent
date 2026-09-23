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
            <div class="message-list no-scrollbar" ref="messageListRef" @scroll="handleScroll">
                <ChatMessageItem v-for="msg in store.activeConversation.messages" :key="msg.id" :msg="msg" :isStreaming="store.isLoading && isLastAssistantMsg(msg)" />
            </div>
            <button v-if="isUserScrolledUp && store.isLoading" class="latest-button" type="button" @click="returnToLatest">
                <i class="fas fa-arrow-down"></i>
                回到最新进度
            </button>
        </template>
        <template v-else>
            <ChatEmptyState :sidebar-collapsed="sidebarCollapsed" @select="handleExample" @open-sidebar="emit('open-sidebar')" />
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

const isUserScrolledUp = ref(false);

function handleScroll(e: Event) {
    const el = e.target as HTMLElement;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    // 给一定容差，超过 50px 认为用户主动上卷了
    isUserScrolledUp.value = distance > 50;
}

function scrollToBottom(force = false) {
    if (!force && isUserScrolledUp.value) return;
    nextTick(() => {
        const el = messageListRef.value;
        if (el) el.scrollTop = el.scrollHeight;
    });
}

function returnToLatest() {
    isUserScrolledUp.value = false;
    nextTick(() => messageListRef.value?.scrollTo({ top: messageListRef.value.scrollHeight, behavior: 'smooth' }));
}

watch(
    () => store.activeConversation?.messages.length,
    (newLen, oldLen) => {
        if (newLen && (!oldLen || newLen > oldLen)) {
            isUserScrolledUp.value = false;
            scrollToBottom(true);
        }
    },
    { immediate: true }
);

watch(
    () => store.activeConversation?.messages,
    () => {
        scrollToBottom(false);
    },
    { deep: true }
);

async function handleExample(query: string) {
    store.startNewChat();
    store.sendMessage(query);
}
</script>

<style scoped>
.chat-detail {
    position: relative;
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

.latest-button {
    position: absolute;
    left: 50%;
    bottom: 112px;
    transform: translateX(-50%);
    z-index: 4;
    display: inline-flex;
    align-items: center;
    gap: 7px;
    padding: 8px 12px;
    border-radius: 999px;
    border: 1px solid var(--da-border);
    background: rgba(24, 30, 43, 0.94);
    color: var(--da-text-main);
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.28);
    cursor: pointer;
}

.latest-button:hover {
    border-color: var(--da-primary);
}

.no-scrollbar::-webkit-scrollbar {
    display: none;
}
.no-scrollbar {
    -ms-overflow-style: none;
    scrollbar-width: none;
}
</style>
