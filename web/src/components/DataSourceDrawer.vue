<template>
  <aside class="da-drawer" :class="{ 'is-open': modelValue }">
    <div class="drawer-header">
      <h2 class="drawer-title">Data Source Context</h2>
      <button
        class="drawer-toggle"
        @click="emit('update:modelValue', false)"
        title="收起抽屉"
      >
        <i class="fas fa-angle-double-right"></i>
      </button>
    </div>

    <!-- Current Source Card -->
    <div class="ds-card source-card" v-if="currentSource">
      <div class="card-accent accent-purple"></div>
      <h3 class="card-subtitle">当前数据源:</h3>
      <p class="card-value">{{ currentSource.name }}</p>
    </div>

    <!-- Active Tables Card -->
    <div class="ds-card tables-card">
      <div class="card-accent accent-blue"></div>
      <h3 class="card-subtitle">当前数据表:</h3>
      <div v-if="loadingSchema" class="text-xs text-da-text-muted">
        Loading...
      </div>
      <ul v-else class="table-list">
        <li
          v-for="table in schemaTables"
          :key="table.tableName"
          class="table-item"
          :class="{ active: selectedTable?.tableName === table.tableName }"
          @click="selectedTable = table"
        >
          <i
            class="fas"
            :class="
              table.isUploaded
                ? 'fa-file-csv text-da-primary'
                : 'fa-database text-da-gradient-end'
            "
          ></i>
          <span class="table-name" :title="table.display_name">{{
            table.tableName
          }}</span>
        </li>
      </ul>
    </div>

    <!-- Data Fields Card -->
    <div class="ds-card fields-card" v-if="selectedTable">
      <div class="card-accent accent-cyan"></div>
      <h3 class="card-subtitle">数据表字段:</h3>
      <ul class="field-list">
        <li
          v-for="field in selectedTable.fields"
          :key="field.name"
          class="field-item"
        >
          <span class="field-name" :title="field.comment">{{
            field.name
          }}</span>
          <span class="field-type">({{ field.type }})</span>
        </li>
      </ul>
    </div>
  </aside>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted } from "vue";
import { useDataSourceStore } from "../stores/datasource";
import { useChatStore } from "../stores/chat";
import { useToastStore } from "../stores/toast";

const props = defineProps<{
  modelValue: boolean; // Controls open/close state
}>();

const emit = defineEmits<{
  (e: "update:modelValue", value: boolean): void;
}>();

const dsStore = useDataSourceStore();
const chatStore = useChatStore();
const toast = useToastStore();

const schemaTables = ref<any[]>([]);
const loadingSchema = ref(false);
const selectedTable = ref<any | null>(null);

const currentSource = computed(() => {
  const dsId =
    chatStore.activeDatasourceId || chatStore.activeConversation?.datasource_id;
  if (dsId) return dsStore.list.find((d) => d.id === dsId);
  // Default to first local DB if none selected
  return dsStore.list.find((d) => d.is_local === 1);
});

async function loadSchema() {
  if (!currentSource.value) return;
  loadingSchema.value = true;
  try {
    schemaTables.value = await dsStore.fetchSchema(currentSource.value.id);
    if (!selectedTable.value && schemaTables.value.length > 0) {
      selectedTable.value = schemaTables.value[0];
    }
  } catch (err: any) {
    console.error("Failed to load schema", err);
    toast.error("获取表格架构失败: " + err.message);
  } finally {
    loadingSchema.value = false;
  }
}

watch(
  () => currentSource.value?.id,
  () => {
    selectedTable.value = null;
    loadSchema();
  },
  { immediate: true },
);

onMounted(() => {
  dsStore.fetchAll();
});
</script>

<style scoped>
.da-drawer {
  width: 300px;
  border-left: 1px solid var(--da-border);
  background: var(--da-panel);
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 16px;
  flex-shrink: 0;
  transition: margin-right 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  overflow: hidden;
}

.da-drawer::-webkit-scrollbar {
  display: none;
}
.da-drawer {
  -ms-overflow-style: none;
  scrollbar-width: none;
}

/* Hide animation logic */
.da-drawer:not(.is-open) {
  margin-right: -300px;
  border-left-color: transparent;
}

.drawer-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0 4px;
}

.drawer-title {
  font-size: 14px;
  font-weight: 600;
  color: #fff;
  letter-spacing: 0.025em;
}

.drawer-toggle {
  background: none;
  border: none;
  color: var(--da-text-muted);
  cursor: pointer;
  transition: color 0.2s;
}
.drawer-toggle:hover {
  color: #fff;
}

.ds-card {
  border-radius: 12px;
  padding: 16px;
  border: 1px solid rgba(51, 58, 77, 0.5); /* da-border/50 */
  background: linear-gradient(to bottom, #2a3142, #1c212e);
  position: relative;
  overflow: hidden;
  box-shadow: 0 1px 2px 0 rgba(0, 0, 0, 0.05);
  transition: border-color 0.2s;
  flex-shrink: 0;
}
.ds-card:hover {
  border-color: var(--da-border);
}

.tables-card {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}

.fields-card {
  display: flex;
  flex-direction: column;
  flex: 2;
  min-height: 0;
}

.card-accent {
  position: absolute;
  top: 0;
  left: 0;
  width: 4px;
  height: 100%;
}
.accent-purple {
  background: rgba(148, 163, 184, 0.3);
}
.accent-blue {
  background: rgba(139, 92, 246, 0.5);
}
.accent-cyan {
  background: rgba(14, 165, 233, 0.5);
}

.card-subtitle {
  font-size: 12px;
  font-weight: 600;
  color: var(--da-text-muted);
  margin-bottom: 8px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.card-value {
  font-size: 14px;
  color: var(--da-text-main);
}

.table-list {
  list-style: none;
  display: flex;
  flex-direction: column;
  flex: 1;
  gap: 4px;
  overflow-y: auto;
  padding-right: 4px;
}

.table-item {
  font-size: 14px;
  color: var(--da-text-main);
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  padding: 8px 10px;
  border-radius: 6px;
  transition: background 0.2s;
  flex-shrink: 0;
}
.table-item:hover {
  background: rgba(255, 255, 255, 0.05);
}
.table-item.active {
  background: rgba(14, 165, 233, 0.1); /* da-primary/10 */
  color: #fff;
}

.table-item i {
  width: 16px;
  font-size: 12px;
}

.table-name {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.field-list {
  list-style: none;
  display: flex;
  flex-direction: column;
  flex: 1;
  gap: 12px;
  overflow-y: auto;
  padding-right: 4px;
}

/* Custom internal scrollbars for table and field lists */
.table-list::-webkit-scrollbar,
.field-list::-webkit-scrollbar {
  width: 4px;
}
.table-list::-webkit-scrollbar-thumb,
.field-list::-webkit-scrollbar-thumb {
  background: var(--da-border);
  border-radius: 2px;
}
.table-list::-webkit-scrollbar-track,
.field-list::-webkit-scrollbar-track {
  background: transparent;
}

.field-item {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  font-size: 14px;
}

.field-name {
  color: var(--da-text-main);
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 160px;
}

.field-type {
  font-size: 12px;
  color: var(--da-text-muted);
  font-family: monospace;
}
</style>
