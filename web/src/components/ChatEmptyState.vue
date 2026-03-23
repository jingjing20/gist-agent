<template>
  <div class="empty-state">
    <div class="empty-icon">
      <svg width="32" height="32" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
        <polyline points="3,18 7,11 12,14 17,6 21,9" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        <circle cx="3" cy="18" r="1.8" fill="white"/>
        <circle cx="7" cy="11" r="1.8" fill="white"/>
        <circle cx="12" cy="14" r="1.8" fill="white"/>
        <circle cx="17" cy="6" r="1.8" fill="white"/>
        <circle cx="21" cy="9" r="1.8" fill="white"/>
      </svg>
    </div>
    <h2>数据分析 Agent</h2>
    <p>选择一个对话或新建对话开始分析</p>
    <div class="active-ds-info" v-if="activeDatasourceName !== '未指定'">
      当前数据源：<span class="highlight">{{ activeDatasourceName }}</span>
    </div>
    <div class="example-queries">
      <template v-if="suggestionsLoading">
        <div v-for="i in 3" :key="i" class="example-btn example-skeleton" />
      </template>
      <template v-else>
        <button
          v-for="q in exampleQueries"
          :key="q"
          class="example-btn"
          @click="emit('select', q)"
        >
          {{ q }}
        </button>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, watch } from 'vue';
import { useChatStore } from '../stores/chat';
import { useDataSourceStore } from '../stores/datasource';

const emit = defineEmits<{ (e: 'select', query: string): void }>();

const chatStore = useChatStore();
const dsStore = useDataSourceStore();

const DEFAULT_QUERIES = [
  '帮我分析下近一月天河平台的日活趋势',
  '对比三个平台最近一周的新增用户数',
  '近 7 天用户行为类型分布是怎样的',
];

const activeDatasourceName = computed(() => {
  const id = chatStore.activeDatasourceId;
  if (id == null) return '未指定';
  const ds = dsStore.list.find((d: any) => d.id === id);
  return ds ? ds.name : `未知 (ID: ${id})`;
});

const suggestionsLoading = computed(() => {
  const id = chatStore.activeDatasourceId;
  return id != null && !!dsStore.suggestionsLoading[id];
});

const exampleQueries = computed(() => {
  const id = chatStore.activeDatasourceId;
  if (id != null && dsStore.suggestionsCache[id]?.length) {
    return dsStore.suggestionsCache[id];
  }
  return DEFAULT_QUERIES;
});

watch(
  () => chatStore.activeDatasourceId,
  (id) => { if (id != null) dsStore.fetchSuggestions(id); },
  { immediate: true },
);
</script>

<style scoped>
.empty-state {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  color: var(--text-secondary);
}

.empty-icon {
  width: 64px;
  height: 64px;
  border-radius: 16px;
  background: linear-gradient(135deg, var(--accent), #8b5cf6);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 28px;
  color: #fff;
  margin-bottom: 8px;
}

.empty-state h2 {
  font-size: 22px;
  color: var(--text-primary);
  margin: 0;
  font-weight: 600;
}

.empty-state p {
  margin: 0;
  font-size: 14px;
}

.active-ds-info {
  margin-top: 4px;
  padding: 6px 16px;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 20px;
  font-size: 13px;
  color: var(--text-secondary);
}

.active-ds-info .highlight {
  color: var(--accent);
  font-weight: 500;
}

.example-queries {
  margin-top: 24px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  align-items: center;
}

.example-btn {
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  color: var(--text-primary);
  padding: 10px 20px;
  border-radius: 10px;
  font-size: 13px;
  cursor: pointer;
  transition: all 0.15s;
  max-width: 400px;
  width: 100%;
  text-align: left;
}

.example-btn:hover {
  background: var(--bg-hover);
  border-color: var(--accent);
}

.example-skeleton {
  height: 40px;
  cursor: default;
  border-color: transparent;
  background: linear-gradient(90deg, var(--bg-secondary) 25%, var(--bg-hover) 50%, var(--bg-secondary) 75%);
  background-size: 200% 100%;
  animation: skeleton-shimmer 1.4s infinite;
}

.example-skeleton:hover {
  background: linear-gradient(90deg, var(--bg-secondary) 25%, var(--bg-hover) 50%, var(--bg-secondary) 75%);
  background-size: 200% 100%;
  border-color: transparent;
}

@keyframes skeleton-shimmer {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}
</style>
