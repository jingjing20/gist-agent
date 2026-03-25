<template>
  <div class="chat-input-wrapper">
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
      <button
        v-if="chatStore.isLoading"
        class="send-btn stop-btn"
        @click="chatStore.abortStream()"
      >
        <i class="fas fa-stop"></i> 取消
      </button>
      <button
        v-else
        class="send-btn"
        :disabled="!inputText.trim()"
        @click="handleSubmit"
      >
        发送 <i class="fas fa-arrow-right text-xs"></i>
      </button>
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

function handleSubmit(e?: Event) {
  e?.preventDefault();
  const text = inputText.value.trim();
  if (!text || chatStore.isLoading) return;
  inputText.value = '';
  nextTick(() => {
    if (textareaRef.value) textareaRef.value.style.height = 'auto';
  });
  chatStore.sendMessage(text);
}
</script>

<style scoped>
.chat-input-wrapper {
  padding: 16px 24px;
  border-top: 1px solid rgba(51, 58, 77, 0.5); /* da-border/50 */
  background: var(--da-bg);
  flex-shrink: 0;
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
  color: rgba(148, 163, 184, 0.6); /* da-text-muted/60 */
}

.send-btn {
  background: var(--da-primary);
  border: none;
  color: #fff;
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
  box-shadow: 0 4px 14px 0 rgba(14, 165, 233, 0.2);
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
  background: #ef4444;
  box-shadow: 0 4px 14px 0 rgba(239, 68, 68, 0.2);
}

.stop-btn:hover {
  background: #dc2626;
}
</style>
