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
                <Select :model-value="chatStore.activeDatasourceId ? String(chatStore.activeDatasourceId) : undefined" @update:model-value="(value) => value && selectDs(Number(value))">
                    <SelectTrigger class="w-full"><SelectValue placeholder="选择数据源" /></SelectTrigger>
                    <SelectContent><SelectGroup>
                        <SelectItem v-for="ds in dsStore.list" :key="ds.id" :value="String(ds.id)">{{ ds.name }}{{ ds.is_local ? ' · 公共库' : '' }}</SelectItem>
                    </SelectGroup></SelectContent>
                </Select>
            </div>

            <!-- 推荐查询区域 -->
            <div class="suggestions-section">
                <div class="section-label">您可能想问</div>
                <div class="suggestions-grid">
                    <template v-if="suggestionsLoading">
                        <Skeleton v-for="i in 3" :key="i" class="h-24 rounded-xl" />
                    </template>
                    <template v-else>
                        <button v-for="q in exampleQueries" :key="q" class="suggestion-card" @click="emit('select', q)">
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
import { computed, watch, onMounted } from 'vue';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { useChatStore } from '../stores/chat';
import { useDataSourceStore } from '../stores/datasource';

withDefaults(
    defineProps<{
        sidebarCollapsed?: boolean;
    }>(),
    {
        sidebarCollapsed: false,
    }
);

const emit = defineEmits<{
    (e: 'select', query: string): void;
    (e: 'open-sidebar'): void;
}>();

const chatStore = useChatStore();
const dsStore = useDataSourceStore();

const DEFAULT_QUERIES = ['帮我分析下近一月平台的日活趋势', '对比不同平台最近一周的新增用户数', '近 7 天用户行为类型分布是怎样的'];

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
}

onMounted(async () => {
    if (!dsStore.list.length) {
        await dsStore.fetchAll();
    }
    // 如果没有激活的数据源，默认选中第一个本地库
    if (!chatStore.activeDatasourceId) {
        const local = dsStore.list.find((d) => d.is_local === 1) || dsStore.list[0];
        if (local) chatStore.activeDatasourceId = local.id;
    }
});

watch(
    () => chatStore.activeDatasourceId,
    (id) => {
        if (id != null) dsStore.fetchSuggestions(id);
    },
    { immediate: true }
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
    color: var(--da-text-main);
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
    color: var(--da-text-main);
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

.no-scrollbar::-webkit-scrollbar {
    display: none;
}
.no-scrollbar {
    -ms-overflow-style: none;
    scrollbar-width: none;
}
</style>
