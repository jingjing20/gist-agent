<template>
  <div class="empty-state-container no-scrollbar">
    <button v-if="sidebarCollapsed" class="expand-sidebar-btn" @click="emit('open-sidebar')" title="展开侧边栏">
      <i class="fas fa-angle-double-right"></i>
    </button>
    <div class="empty-state-content">
      <div class="hero-section">
        <div class="brand-icon">
          <i class="fas fa-chart-line"></i>
        </div>
        <div class="hero-text-content">
          <h1 class="hero-title">Gist Agent</h1>
          <p class="hero-subtitle">基于 AI 的智能数据分析专家，助你快速洞察业务本质</p>
        </div>
      </div>

      <!-- 数据源选择区域 -->
      <div class="ds-selection-box">
        <div class="section-label">选择数据源</div>
        <div
          class="custom-ds-select"
          :class="{ open: dsOpen }"
          tabindex="0"
          @blur="dsOpen = false"
        >
          <div class="ds-trigger" @click="dsOpen = !dsOpen">
            <div class="ds-info">
              <i v-if="activeDs?.is_local" class="fas fa-database ds-type-icon"></i>
              <i v-else class="fas fa-file-csv ds-type-icon"></i>
              <span class="ds-value">{{ activeDatasourceName }}</span>
            </div>
            <i class="fas fa-chevron-down chevron"></i>
          </div>

          <div v-if="dsOpen" class="ds-dropdown">
            <div
              v-for="ds in dsStore.list"
              :key="ds.id"
              class="ds-option"
              :class="{ selected: ds.id === chatStore.activeDatasourceId }"
              @mousedown.prevent="selectDs(ds.id)"
            >
              <div class="ds-option-label">
                <i :class="ds.is_local ? 'fas fa-database' : 'fas fa-file-csv'"></i>
                <span>{{ ds.name }}</span>
              </div>
              <span v-if="ds.is_local" class="local-badge">公共库</span>
            </div>
          </div>
        </div>
      </div>

      <!-- 推荐查询区域 -->
      <div class="suggestions-section">
        <div class="section-label">您可能想问</div>
        <div class="suggestions-grid">
          <template v-if="suggestionsLoading">
            <div v-for="i in 3" :key="i" class="suggestion-card skeleton" />
          </template>
          <template v-else>
            <button
              v-for="q in exampleQueries"
              :key="q"
              class="suggestion-card"
              @click="emit('select', q)"
            >
              <span class="query-text">{{ q }}</span>
              <i class="fas fa-arrow-right query-icon"></i>
            </button>
          </template>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue';
import { useChatStore } from '../stores/chat';
import { useDataSourceStore } from '../stores/datasource';

withDefaults(defineProps<{
  sidebarCollapsed?: boolean;
}>(), {
  sidebarCollapsed: false
});

const emit = defineEmits<{
  (e: 'select', query: string): void;
  (e: 'open-sidebar'): void;
}>();

const chatStore = useChatStore();
const dsStore = useDataSourceStore();

const dsOpen = ref(false);

const DEFAULT_QUERIES = [
  '帮我分析下近一月平台的日活趋势',
  '对比不同平台最近一周的新增用户数',
  '近 7 天用户行为类型分布是怎样的',
];

const activeDs = computed(() => {
  return dsStore.list.find(d => d.id === chatStore.activeDatasourceId);
});

const activeDatasourceName = computed(() => {
  return activeDs.value?.name || '选择数据源';
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

function selectDs(id: number) {
  chatStore.activeDatasourceId = id;
  dsOpen.value = false;
}

onMounted(async () => {
  if (!dsStore.list.length) {
    await dsStore.fetchAll();
  }
  // 如果没有激活的数据源，默认选中第一个本地库
  if (!chatStore.activeDatasourceId) {
    const local = dsStore.list.find(d => d.is_local === 1) || dsStore.list[0];
    if (local) chatStore.activeDatasourceId = local.id;
  }
});

watch(
  () => chatStore.activeDatasourceId,
  (id) => { if (id != null) dsStore.fetchSuggestions(id); },
  { immediate: true },
);
</script>

<style scoped>
.empty-state-container {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  overflow-y: auto;
  padding: 80px 24px;
  position: relative;
}

.expand-sidebar-btn {
  position: absolute;
  top: 16px;
  left: 24px;
  background: none;
  border: none;
  color: var(--da-text-muted);
  font-size: 16px;
  cursor: pointer;
  transition: color 0.2s;
  padding: 4px;
}

.expand-sidebar-btn:hover {
  color: #fff;
}

.empty-state-content {
  max-width: 800px;
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 32px;
}

/* Hero Section */
.hero-section {
  display: flex;
  align-items: center;
  gap: 24px;
  text-align: left;
}

.brand-icon {
  width: 72px;
  height: 72px;
  background: linear-gradient(135deg, var(--da-primary), #8b5cf6);
  border-radius: 18px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 32px;
  color: #fff;
  flex-shrink: 0;
  box-shadow: 0 12px 32px rgba(14, 165, 233, 0.3);
}

.hero-text-content {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.hero-title {
  font-size: 32px;
  font-weight: 850;
  color: #fff;
  margin: 0;
  letter-spacing: -0.03em;
}

.hero-subtitle {
  font-size: 14px;
  color: var(--da-text-muted);
  max-width: 500px;
  line-height: 1.6;
  margin: 0;
  opacity: 0.9;
}

.section-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--da-text-muted);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  margin-bottom: 12px;
}

/* Data Source Selection */
.ds-selection-box {
  background: var(--da-panel);
  border: 1px solid var(--da-border);
  border-radius: 16px;
  padding: 16px 20px; /* Reduced from 24px */
  display: flex;
  flex-direction: column;
}

.custom-ds-select {
  position: relative;
  outline: none;
}

.ds-trigger {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  background: var(--da-card);
  border: 1px solid var(--da-border);
  border-radius: 10px;
  cursor: pointer;
  transition: all 0.2s;
}

.ds-trigger:hover {
  border-color: var(--da-primary);
  background: rgba(255, 255, 255, 0.03);
}

.ds-info {
  display: flex;
  align-items: center;
  gap: 12px;
}

.ds-type-icon {
  color: var(--da-primary);
  font-size: 16px;
}

.ds-value {
  font-size: 15px;
  font-weight: 500;
  color: var(--da-text-main);
}

.chevron {
  font-size: 12px;
  color: var(--da-text-muted);
  transition: transform 0.2s;
}

.custom-ds-select.open .chevron {
  transform: rotate(180deg);
}

.ds-dropdown {
  position: absolute;
  top: calc(100% + 8px);
  left: 0;
  right: 0;
  background: var(--da-card);
  border: 1px solid var(--da-border);
  border-radius: 10px;
  padding: 8px;
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.4);
  z-index: 100;
  animation: slideDown 0.2s cubic-bezier(0, 0, 0.2, 1);
}

@keyframes slideDown {
  from { opacity: 0; transform: translateY(-10px); }
  to { opacity: 1; transform: translateY(0); }
}

.ds-option {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  border-radius: 8px;
  cursor: pointer;
  transition: background 0.2s;
}

.ds-option:hover {
  background: rgba(255, 255, 255, 0.05);
}

.ds-option.selected {
  background: rgba(14, 165, 233, 0.1);
  color: var(--da-primary);
}

.ds-option-label {
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 14px;
  font-weight: 500;
}

.local-badge {
  font-size: 11px;
  padding: 2px 6px;
  background: rgba(14, 165, 233, 0.15);
  color: var(--da-primary);
  border-radius: 4px;
}

/* Suggestions Section */
.suggestions-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 16px;
}

.suggestion-card {
  background: var(--da-card);
  border: 1px solid var(--da-border);
  border-radius: 12px;
  padding: 16px;
  text-align: left;
  cursor: pointer;
  transition: all 0.2s;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  gap: 8px;
  height: 120px;
  position: relative;
}

.suggestion-card:hover {
  border-color: var(--da-primary);
  background: rgba(14, 165, 233, 0.05);
  transform: translateY(-2px);
}

.query-text {
  font-size: 14px;
  line-height: 1.5;
  color: var(--da-text-main);
  font-weight: 400;
  /* Line clamp for 3 lines */
  display: -webkit-box;
  -webkit-line-clamp: 3;
  line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
  text-overflow: ellipsis;
}

.query-icon {
  font-size: 12px;
  color: var(--da-text-muted);
  transition: all 0.2s;
  align-self: flex-end;
}

.suggestion-card:hover .query-icon {
  transform: translateX(4px);
  color: var(--da-primary);
}

/* Skeleton */
.skeleton {
  background: linear-gradient(90deg, var(--da-card) 25%, var(--da-border) 50%, var(--da-card) 75%);
  background-size: 200% 100%;
  animation: shimmer 1.5s infinite;
  border-color: transparent !important;
}

@keyframes shimmer {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}

.no-scrollbar::-webkit-scrollbar {
  display: none;
}
.no-scrollbar {
  -ms-overflow-style: none;
  scrollbar-width: none;
}
</style>
