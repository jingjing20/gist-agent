<template>
    <div class="chat-input-wrapper">
        <div class="generation-modes">
            <button
                type="button"
                class="mode-toggle"
                :class="{ active: chatStore.reasoningEnabled }"
                :aria-pressed="chatStore.reasoningEnabled"
                :disabled="chatStore.isLoading"
                title="让模型在回答前进行更深入的推理"
                @click="chatStore.reasoningEnabled = !chatStore.reasoningEnabled"
            >
                <i class="fas fa-brain"></i>
                深度思考
            </button>
        </div>
        <div class="input-container">
            <textarea
                ref="textareaRef"
                v-model="inputText"
                class="input-field"
                placeholder="输入你的数据分析需求..."
                rows="1"
                @keydown.enter.exact="handleSubmit"
                @input="autoResize"
            />
            <button v-if="chatStore.isLoading" class="send-btn stop-btn" :disabled="chatStore.activeGeneration?.status === 'cancel_requested'" @click="chatStore.abortStream()">
                <i class="fas fa-stop"></i> {{ chatStore.activeGeneration?.status === 'cancel_requested' ? '正在停止' : '停止分析' }}
            </button>
            <button v-else class="send-btn" :disabled="!inputText.trim()" @click="handleSubmit">发送 <i class="fas fa-arrow-right text-xs"></i></button>
        </div>
    </div>
</template>

<script setup lang="ts">
import { ref, nextTick, onMounted } from 'vue';
import { useChatStore } from '../stores/chat';
import { useDataSourceStore } from '../stores/datasource';

const chatStore = useChatStore();
const dsStore = useDataSourceStore();

const inputText = ref('');
const textareaRef = ref<HTMLTextAreaElement>();

onMounted(async () => {
    if (!dsStore.list.length) {
        await dsStore.fetchAll();
    }
});

function autoResize() {
    const el = textareaRef.value;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 150) + 'px';
}

async function handleSubmit(e?: Event) {
    e?.preventDefault();
    const text = inputText.value.trim();
    if (!text || chatStore.isLoading) return;
    inputText.value = '';
    nextTick(() => {
        if (textareaRef.value) textareaRef.value.style.height = 'auto';
    });
    const conversationId = chatStore.activeConversationId;
    const sent = await chatStore.sendMessage(text);
    if (!sent && !inputText.value && (conversationId === chatStore.activeConversationId || conversationId === null)) {
        inputText.value = text;
        await nextTick();
        autoResize();
    }
}
</script>

<style scoped>
.chat-input-wrapper {
    padding: 16px 24px;
    border-top: 1px solid color-mix(in srgb, var(--da-border) 50%, transparent); /* da-border/50 */
    background: var(--da-bg);
    flex-shrink: 0;
}

.generation-modes {
    max-width: 800px;
    margin: 0 auto 8px;
}

.mode-toggle {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    border: 1px solid var(--da-border);
    border-radius: 8px;
    padding: 6px 10px;
    background: transparent;
    color: var(--da-text-muted);
    font: inherit;
    font-size: 13px;
    cursor: pointer;
    transition: all 0.2s;
}

.mode-toggle:hover:not(:disabled) {
    border-color: var(--da-primary);
    color: var(--da-text-main);
}

.mode-toggle.active {
    border-color: var(--da-primary);
    background: color-mix(in srgb, var(--status-info) 12%, transparent);
    color: var(--da-primary);
}

.mode-toggle:disabled {
    cursor: not-allowed;
    opacity: 0.5;
}

.input-container {
    max-width: 800px;
    margin: 0 auto;
    display: flex;
    align-items: center;
    gap: 12px;
    background: var(--da-card);
    border: 1px solid var(--da-border);
    border-radius: 12px;
    padding: 12px 16px;
    transition: all 0.2s;
}

.input-container:focus-within {
    border-color: var(--da-primary);
    box-shadow: 0 0 0 1px var(--da-primary);
}

.input-field {
    flex: 1;
    border: none;
    background: transparent;
    color: var(--da-text-main);
    font-size: 14px;
    line-height: 1.5;
    resize: none;
    outline: none;
    font-family: inherit;
    max-height: 150px;
}

.input-field::placeholder {
    color: color-mix(in srgb, var(--da-text-muted) 60%, transparent); /* da-text-muted/60 */
}

.send-btn {
    background: var(--da-primary);
    border: none;
    color: var(--primary-foreground);
    padding: 8px 16px;
    border-radius: 8px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    transition: all 0.2s;
    font-size: 14px;
    font-weight: 500;
    gap: 8px;
    box-shadow: 0 4px 14px 0 color-mix(in srgb, var(--status-info) 20%, transparent);
}

.send-btn:hover:not(:disabled) {
    background: var(--da-primary-hover);
}

.send-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
    box-shadow: none;
}

.stop-btn {
    background: var(--destructive);
    box-shadow: 0 4px 14px 0 color-mix(in srgb, var(--destructive) 20%, transparent);
}

.stop-btn:hover {
    background: var(--destructive-hover);
}
</style>
