<template>
  <div class="chat-input-wrapper">
    <!-- 数据源选择器 -->
    <div class="ds-selector-row">
      <select
        id="datasource-select"
        v-model="selectedDatasourceId"
        class="ds-select"
        @change="chatStore.activeDatasourceId = selectedDatasourceId"
      >
        <option v-for="ds in dsStore.list" :key="ds.id" :value="ds.id">
          {{ ds.name }}{{ ds.is_local ? ' (默认)' : '' }}
        </option>
      </select>
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
      <button
        class="send-btn"
        :disabled="!inputText.trim() || chatStore.isLoading"
        @click="handleSubmit"
      >
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" />
        </svg>
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, nextTick, onMounted, watch } from 'vue';
import { useChatStore } from '../stores/chat';
import { useDataSourceStore } from '../stores/datasource';

const chatStore = useChatStore();
const dsStore = useDataSourceStore();

const inputText = ref('');
const textareaRef = ref<HTMLTextAreaElement>();
const selectedDatasourceId = ref<number | null>(null);

onMounted(async () => {
  if (!dsStore.list.length) {
    await dsStore.fetchAll();
  }
  // 默认选中本地默认库
  const local = dsStore.list.find(d => d.is_local);
  if (local) {
    selectedDatasourceId.value = local.id;
    chatStore.activeDatasourceId = local.id;
  }
});

// 当数据源列表变化时（上传文件后），同步默认选中
watch(() => dsStore.list.length, () => {
  if (!selectedDatasourceId.value) {
    const local = dsStore.list.find(d => d.is_local);
    if (local) {
      selectedDatasourceId.value = local.id;
      chatStore.activeDatasourceId = local.id;
    }
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
  padding: 10px 24px 24px;
  border-top: 1px solid var(--border);
  background: var(--bg-primary);
}

.ds-selector-row {
  max-width: 800px;
  margin: 0 auto 8px;
  display: flex;
  align-items: center;
  gap: 8px;
}

.ds-select {
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  color: var(--text-secondary);
  font-size: 12px;
  padding: 5px 10px;
  border-radius: 7px;
  outline: none;
  cursor: pointer;
  font-family: inherit;
  transition: border-color 0.15s, color 0.15s;
}

.ds-select:hover,
.ds-select:focus {
  border-color: var(--accent);
  color: var(--text-primary);
}

.input-container {
  max-width: 800px;
  margin: 0 auto;
  display: flex;
  align-items: flex-end;
  gap: 10px;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 10px 14px;
  transition: border-color 0.15s;
}

.input-container:focus-within {
  border-color: var(--accent);
}

.input-field {
  flex: 1;
  border: none;
  background: none;
  color: var(--text-primary);
  font-size: 14px;
  line-height: 1.5;
  resize: none;
  outline: none;
  font-family: inherit;
  max-height: 150px;
}

.input-field::placeholder {
  color: var(--text-secondary);
}

.send-btn {
  background: var(--accent);
  border: none;
  color: #fff;
  width: 36px;
  height: 36px;
  border-radius: 8px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  transition: background 0.15s, opacity 0.15s;
}

.send-btn:hover:not(:disabled) {
  background: var(--accent-hover);
}

.send-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
</style>
