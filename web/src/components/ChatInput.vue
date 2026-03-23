<template>
  <div class="chat-input-wrapper">
    <!-- 数据源选择器 -->
    <div class="ds-selector-row">
      <div
        class="custom-ds-select"
        :class="{ disabled: !!chatStore.activeConversationId, open: dsOpen }"
        tabindex="0"
        @blur="dsOpen = false"
      >
        <div class="ds-trigger" @click="toggleDsDropdown">
          <svg v-if="activeDs?.is_local" class="ds-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"></ellipse><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"></path><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"></path></svg>
          <svg v-else class="ds-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>
          <span class="ds-value">{{ activeDatasourceName }}</span>
          <svg class="chevron" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>
        </div>
        <div v-if="dsOpen" class="ds-dropdown">
          <div
            v-for="ds in dsStore.list"
            :key="ds.id"
            class="ds-option"
            :class="{ selected: ds.id === chatStore.activeDatasourceId }"
            @mousedown.prevent="selectDs(ds.id)"
          >
            <span class="ds-option-name">{{ ds.name }}</span>
            <span v-if="ds.is_local" class="ds-local-badge">公共</span>
          </div>
        </div>
      </div>
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
        v-if="chatStore.isLoading"
        class="send-btn stop-btn"
        @click="chatStore.abortStream()"
      >
        <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
          <rect x="6" y="6" width="12" height="12" rx="2" />
        </svg>
      </button>
      <button
        v-else
        class="send-btn"
        :disabled="!inputText.trim()"
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
import { ref, computed, nextTick, onMounted, watch } from 'vue';
import { useChatStore } from '../stores/chat';
import { useDataSourceStore } from '../stores/datasource';

const chatStore = useChatStore();
const dsStore = useDataSourceStore();

const inputText = ref('');
const textareaRef = ref<HTMLTextAreaElement>();

const dsOpen = ref(false);

const activeDs = computed(() => {
  return dsStore.list.find(d => d.id === chatStore.activeDatasourceId);
});

const activeDatasourceName = computed(() => {
  const ds = activeDs.value;
  if (!ds) return '选择数据源';
  return ds.name;
});

function toggleDsDropdown() {
  if (chatStore.activeConversationId) return;
  dsOpen.value = !dsOpen.value;
}

function selectDs(id: number) {
  if (chatStore.activeConversationId) return;
  chatStore.activeDatasourceId = id;
  dsOpen.value = false;
}

onMounted(async () => {
  if (!dsStore.list.length) {
    await dsStore.fetchAll();
  }
  // 默认选中本地默认库
  if (!chatStore.activeDatasourceId) {
    const local = dsStore.list.find(d => d.is_local);
    if (local) {
      chatStore.activeDatasourceId = local.id;
    }
  }
});

// 当数据源列表变化时（上传文件后），同步默认选中
watch(() => dsStore.list.length, () => {
  if (!chatStore.activeDatasourceId) {
    const local = dsStore.list.find(d => d.is_local);
    if (local) {
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
}

.custom-ds-select {
  position: relative;
  outline: none;
  border-radius: 8px;
}

.ds-trigger {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 8px;
  cursor: pointer;
  color: var(--text-secondary);
  transition: all 0.15s;
}

.custom-ds-select:not(.disabled) .ds-trigger:hover,
.custom-ds-select.open .ds-trigger {
  border-color: var(--accent);
  color: var(--text-primary);
  background: var(--bg-primary);
}

.custom-ds-select.disabled .ds-trigger {
  opacity: 0.6;
  cursor: not-allowed;
  background: var(--bg-primary);
}

.ds-icon {
  flex-shrink: 0;
  opacity: 0.8;
}

.ds-value {
  font-size: 13px;
  font-weight: 500;
  white-space: nowrap;
  text-overflow: ellipsis;
  overflow: hidden;
  max-width: 150px;
}

.chevron {
  flex-shrink: 0;
  transition: transform 0.2s;
  opacity: 0.6;
}

.custom-ds-select.open .chevron {
  transform: rotate(180deg);
}

.ds-dropdown {
  position: absolute;
  bottom: calc(100% + 4px);
  left: 0;
  min-width: 200px;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 4px;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.2);
  z-index: 100;
  animation: slideUp 0.15s ease-out;
}

@keyframes slideUp {
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: translateY(0); }
}

.ds-option {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 10px;
  border-radius: 6px;
  cursor: pointer;
  transition: background 0.12s;
}

.ds-option:hover {
  background: var(--bg-hover);
}

.ds-option.selected {
  background: rgba(99, 102, 241, 0.1);
  color: var(--accent);
}

.ds-option-name {
  font-size: 13px;
  font-weight: 500;
}

.ds-local-badge {
  font-size: 10px;
  color: var(--accent);
  background: rgba(99, 102, 241, 0.15);
  padding: 1px 5px;
  border-radius: 4px;
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

.stop-btn {
  background: #ef4444;
}

.stop-btn:hover {
  background: #dc2626;
}
</style>
