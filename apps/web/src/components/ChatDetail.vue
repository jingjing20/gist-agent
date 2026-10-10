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
            <div
                class="message-list no-scrollbar"
                ref="messageListRef"
                tabindex="0"
                @scroll="handleScroll"
                @wheel.passive="handleIntent"
                @touchmove.passive="handleIntent"
                @keydown="handleKey"
                @pointerdown="handlePointer"
                @result-panel-open="openResultPanel"
                @result-panel-close="closeResultPanel"
            >
                <div ref="messageContentRef">
                    <ChatMessageItem v-for="msg in store.activeConversation.messages" :key="msg.id" :msg="msg" :isStreaming="store.isLoading && isLastAssistantMsg(msg)" />
                </div>
            </div>
            <button v-if="hasContentBelow" class="latest-button" type="button" :aria-label="store.isLoading ? '正在生成，滚动到最新内容' : '滚动到最下面'" @click="returnToLatest">
                <span v-if="store.isLoading" class="latest-dots" aria-hidden="true"><span></span><span></span><span></span></span>
                <i v-else class="fas fa-arrow-down" aria-hidden="true"></i>
            </button>
        </template>
        <template v-else>
            <ChatEmptyState :sidebar-collapsed="sidebarCollapsed" @select="handleExample" @open-sidebar="emit('open-sidebar')" />
        </template>
        <ChatInput />
    </div>
</template>

<script setup lang="ts">
import { watch, nextTick, ref, onBeforeUnmount } from 'vue';
import { isAtBottom, shouldPauseFollowing } from '../utils/scroll-follow';
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

const messageContentRef = ref<HTMLElement>();
const following = ref(true);
const hasContentBelow = ref(false);
const panelOpen = ref(false);
let userIntent = false;
let lastTop = 0;
let lastHeight = 0;
let lastViewport = 0;
let intentFrame: number | undefined;
let observer: ResizeObserver | undefined;
let inputObserver: ResizeObserver | undefined;
function openResultPanel() {
    panelOpen.value = true;
    following.value = false;
}
function closeResultPanel() {
    panelOpen.value = false;
    const el = messageListRef.value;
    following.value = !!el && isAtBottom(el);
    updatePosition();
}

function updatePosition() {
    const el = messageListRef.value;
    if (el) hasContentBelow.value = !isAtBottom(el);
}
function handleIntent() {
    userIntent = true;
    // Pause before the next content resize can move the reading position.
    following.value = false;
    if (typeof requestAnimationFrame === 'function') {
        cancelAnimationFrame(intentFrame || 0);
        intentFrame = requestAnimationFrame(() => {
            const el = messageListRef.value;
            if (userIntent && el && isAtBottom(el)) {
                following.value = true;
                userIntent = false;
            }
        });
    }
}
function handleKey(event: KeyboardEvent) {
    if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) handleIntent();
}
function handlePointer(event: PointerEvent) {
    const el = messageListRef.value;
    if (el && event.clientX >= el.getBoundingClientRect().right - 16) handleIntent();
}
function handleScroll() {
    const el = messageListRef.value;
    if (!el || panelOpen.value) return;
    if (shouldPauseFollowing(el.scrollTop, lastTop, userIntent, el.scrollHeight !== lastHeight || el.clientHeight !== lastViewport)) following.value = false;
    if (userIntent || !following.value) following.value = isAtBottom(el);
    userIntent = false;
    lastTop = el.scrollTop;
    lastHeight = el.scrollHeight;
    lastViewport = el.clientHeight;
    updatePosition();
}
function scrollToBottom() {
    nextTick(() => {
        const el = messageListRef.value;
        if (!el || panelOpen.value) return;
        if (following.value) {
            el.scrollTop = el.scrollHeight;
            lastTop = el.scrollTop;
            lastHeight = el.scrollHeight;
            lastViewport = el.clientHeight;
        }
        updatePosition();
    });
}
function returnToLatest() {
    following.value = true;
    userIntent = false;
    scrollToBottom();
}
watch(
    messageContentRef,
    (content) => {
        observer?.disconnect();
        observer = new ResizeObserver(scrollToBottom);
        if (content) observer.observe(content);
        if (messageListRef.value) observer.observe(messageListRef.value);
        inputObserver?.disconnect();
        const detail = messageListRef.value?.parentElement;
        const input = detail?.querySelector('.chat-input-wrapper');
        if (input && detail) {
            inputObserver = new ResizeObserver(() => detail.style.setProperty('--chat-input-height', `${input.getBoundingClientRect().height}px`));
            inputObserver.observe(input);
        }
    },
    { flush: 'post' }
);
watch(
    () => store.activeConversationId,
    () => {
        following.value = true;
        userIntent = false;
        scrollToBottom();
    }
);
watch(
    () => store.activeConversation?.messages.length,
    (length, previous) => {
        if (length && length !== previous) {
            scrollToBottom();
        }
    },
    { immediate: true }
);
watch(
    () => store.activeConversation?.messages.filter((message) => message.role === 'user').at(-1)?.id,
    () => {
        following.value = true;
        scrollToBottom();
    }
);
watch(() => store.activeConversation?.messages, scrollToBottom, { deep: true });
watch(panelOpen, (open) => {
    if (!open) updatePosition();
});
onBeforeUnmount(() => {
    observer?.disconnect();
    inputObserver?.disconnect();
    if (intentFrame !== undefined) cancelAnimationFrame(intentFrame);
});

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
    border-bottom: 1px solid color-mix(in srgb, var(--da-border) 50%, transparent); /* da-border/50 */
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
    color: var(--da-text-main);
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
    color: var(--da-text-main);
}

.message-list {
    flex: 1;
    overflow-y: auto;
    padding: 24px;
}

.latest-button {
    position: absolute;
    left: 50%;
    bottom: calc(var(--chat-input-height, 112px) + 12px);
    transform: translateX(-50%);
    z-index: 4;
    display: inline-flex;
    align-items: center;
    width: 40px;
    height: 40px;
    justify-content: center;
    padding: 0;
    border-radius: 999px;
    border: 1px solid var(--da-border);
    background: var(--da-panel);
    color: var(--da-text-main);
    box-shadow: 0 8px 24px color-mix(in srgb, var(--shadow-color) 28.000000000000004%, transparent);
    cursor: pointer;
}

.latest-dots {
    display: flex;
    gap: 4px;
}
.latest-dots span {
    width: 4px;
    height: 4px;
    border-radius: 50%;
    background: currentColor;
    animation: latest-bounce 1.2s infinite ease-in-out;
}
.latest-dots span:nth-child(2) {
    animation-delay: 0.15s;
}
.latest-dots span:nth-child(3) {
    animation-delay: 0.3s;
}
@keyframes latest-bounce {
    0%,
    70%,
    100% {
        transform: translateY(0);
        opacity: 0.5;
    }
    35% {
        transform: translateY(-3px);
        opacity: 1;
    }
}
@media (prefers-reduced-motion: reduce) {
    .latest-dots span {
        animation: none;
    }
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
