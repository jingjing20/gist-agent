<template>
    <div class="ds-view no-scrollbar">
        <div class="ds-header">
            <div class="header-content">
                <h2 class="page-title">数据源管理</h2>
                <p class="page-subtitle">连接并管理你的数据分析资产</p>
            </div>
            <button class="add-ds-btn" @click="showCreateModal = true"><i class="fas fa-plus"></i> 新建数据源</button>
        </div>

        <div class="ds-grid">
            <div v-if="dsStore.loading" v-for="i in 3" :key="'skeleton' + i" class="skeleton-card"></div>

            <div v-else-if="!dsStore.list.length" class="empty-state">
                <i class="fas fa-database empty-icon"></i>
                <h3>暂无数据源</h3>
                <p>上传你的第一个 CSV 或 Excel 文件开始分析</p>
            </div>

            <DataSourceCard
                v-for="ds in dsStore.list"
                :key="ds.id"
                :ds="ds"
                @upload="openUpload"
                @edit="handleEditOpen"
                @grant="openGrant"
                @view-tables="openTables"
                @delete="promptDeleteDs"
            />
        </div>

        <!-- Modals -->
        <CreateSourceModal v-model="showCreateModal" :submitting="createSubmitting" :error="createError" @submit="handleCreate" />

        <EditSourceModal v-model="editTargetDs" :submitting="editSubmitting" :error="editError" @submit="handleEditSubmit" />

        <UploadTableModal v-model="uploadTargetDs" :submitting="uploading" :error="uploadError" @submit="handleUpload" />

        <GrantPermissionModal
            v-model="grantDs"
            :grantedUsers="grantedUsers"
            :searchResults="grantSearchResults"
            :authUser="authStore.user"
            @search="debouncedSearch"
            @grant="handleGrant"
            @revoke="handleRevoke"
        />

        <TableListModal v-model="showingTablesDs" :tables="tables" :loading="tablesLoading" @delete-table="promptDeleteTable" />

        <ConfirmModal
            v-model="deleteConfirm.show"
            :title="deleteConfirm.title"
            :desc="deleteConfirm.desc"
            :loading="deleteSubmitting"
            loadingText="删除中..."
            confirmText="确认删除"
            @confirm="executeDelete"
        />
    </div>
</template>

<script setup lang="ts">
import { ref, onMounted, reactive } from 'vue';
import { useDataSourceStore } from '../stores/datasource';
import { useAuthStore } from '../stores/auth';
import { useToastStore } from '../stores/toast';
import { apiFetch } from '../api';
import DataSourceCard from '../components/datasource/DataSourceCard.vue';
import CreateSourceModal from '../components/datasource/CreateSourceModal.vue';
import EditSourceModal from '../components/datasource/EditSourceModal.vue';
import UploadTableModal from '../components/datasource/UploadTableModal.vue';
import GrantPermissionModal from '../components/datasource/GrantPermissionModal.vue';
import TableListModal from '../components/datasource/TableListModal.vue';
import ConfirmModal from '../components/ConfirmModal.vue';
import type { DataSource, UploadedTable } from '../stores/datasource';

const dsStore = useDataSourceStore();
const authStore = useAuthStore();
const toast = useToastStore();

onMounted(() => dsStore.fetchAll());

// --- Create ---
const showCreateModal = ref(false);
const createSubmitting = ref(false);
const createError = ref('');
async function handleCreate(form: { name: string; description?: string }) {
    createError.value = '';
    createSubmitting.value = true;
    try {
        await dsStore.create({ name: form.name, description: form.description });
        showCreateModal.value = false;
        toast.success('数据源创建成功');
    } catch (e: any) {
        createError.value = e.message;
        toast.error('创建失败: ' + e.message);
    } finally {
        createSubmitting.value = false;
    }
}

// --- Edit ---
const editTargetDs = ref<DataSource | null>(null);
const editSubmitting = ref(false);
const editError = ref('');

function handleEditOpen(ds: DataSource) {
    editTargetDs.value = ds;
    editError.value = '';
}

async function handleEditSubmit(form: { name: string; description: string }) {
    if (!editTargetDs.value) return;
    editSubmitting.value = true;
    editError.value = '';
    try {
        await dsStore.update(editTargetDs.value.id, form);
        editTargetDs.value = null;
        toast.success('数据源更新成功');
    } catch (e: any) {
        editError.value = e.message;
        toast.error('更新失败: ' + e.message);
    } finally {
        editSubmitting.value = false;
    }
}

// --- Upload ---
const uploadTargetDs = ref<DataSource | null>(null);
const uploading = ref(false);
const uploadError = ref('');
function openUpload(ds: DataSource) {
    uploadTargetDs.value = ds;
    uploadError.value = '';
}
async function handleUpload(_id: number, file: File, tableConfigs: { sheetName?: string; displayName: string }[]) {
    if (!uploadTargetDs.value) return;
    uploadError.value = '';
    uploading.value = true;
    try {
        await dsStore.uploadTable(uploadTargetDs.value.id, file, tableConfigs);
        if (showingTablesDs.value?.id === uploadTargetDs.value.id) {
            tables.value = await dsStore.listTables(uploadTargetDs.value.id);
        }
        uploadTargetDs.value = null;
        toast.success('文件上传并同步成功');
    } catch (e: any) {
        uploadError.value = e.message;
        toast.error('上传失败: ' + e.message);
    } finally {
        uploading.value = false;
    }
}

// --- Permissions ---
const grantDs = ref<DataSource | null>(null);
const grantSearchResults = ref<any[]>([]);
const grantedUsers = ref<any[]>([]);
let searchTimer: any;

async function openGrant(ds: DataSource) {
    grantDs.value = ds;
    grantSearchResults.value = [];
    grantedUsers.value = [];
    loadPermissions();
}

async function loadPermissions() {
    if (!grantDs.value) return;
    try {
        grantedUsers.value = await dsStore.listPermissions(grantDs.value.id);
    } catch {
        grantedUsers.value = [];
    }
}

function debouncedSearch(q: string) {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
        if (q.trim().length < 2) {
            grantSearchResults.value = [];
            return;
        }
        apiFetch(`/users/search?q=${encodeURIComponent(q)}`)
            .then((r) => r.json())
            .then((data) => {
                grantSearchResults.value = data;
            });
    }, 300);
}

async function handleGrant(userId: number) {
    if (!grantDs.value) return;
    try {
        await dsStore.grant(grantDs.value.id, userId);
        await loadPermissions();
        toast.success('权限授权成功');
    } catch (e: any) {
        toast.error('授权失败: ' + e.message);
    }
}

async function handleRevoke(userId: number) {
    if (!grantDs.value) return;
    try {
        await dsStore.revoke(grantDs.value.id, userId);
        await loadPermissions();
        toast.success('权限取消成功');
    } catch (e: any) {
        toast.error('取消授权失败: ' + e.message);
    }
}

// --- Tables ---
const showingTablesDs = ref<DataSource | null>(null);
const tables = ref<UploadedTable[]>([]);
const tablesLoading = ref(false);
const PRESET_TABLES = [
    { table_name: 'platform_info', display_name: '平台信息' },
    { table_name: 'daily_active_stats', display_name: '日活统计' },
    { table_name: 'user_behavior_log', display_name: '用户行为日志' },
];
async function openTables(ds: DataSource) {
    showingTablesDs.value = ds;
    if (ds.is_local) {
        tables.value = PRESET_TABLES as any;
    } else {
        tablesLoading.value = true;
        try {
            tables.value = await dsStore.listTables(ds.id);
        } catch {
            tables.value = [];
        } finally {
            tablesLoading.value = false;
        }
    }
}

// --- Delete ---
const deleteConfirm = reactive({
    show: false,
    title: '',
    desc: '',
    type: '' as 'ds' | 'table',
    dsId: 0,
    tableId: 0,
});
const deleteSubmitting = ref(false);

function promptDeleteDs(id: number) {
    deleteConfirm.title = '确认删除数据源';
    deleteConfirm.desc = '确定要删除此数据源吗？所有上传的表和访问授权都将被移除，此操作不可逆。';
    deleteConfirm.type = 'ds';
    deleteConfirm.dsId = id;
    deleteConfirm.show = true;
}

function promptDeleteTable(dsId: number, tableId: number) {
    deleteConfirm.title = '确认删除表';
    deleteConfirm.desc = '确认删除此表？数据将无法恢复。';
    deleteConfirm.type = 'table';
    deleteConfirm.dsId = dsId;
    deleteConfirm.tableId = tableId;
    deleteConfirm.show = true;
}

async function executeDelete() {
    deleteSubmitting.value = true;
    try {
        if (deleteConfirm.type === 'ds') {
            await dsStore.remove(deleteConfirm.dsId);
            toast.success('数据源删除成功');
        } else if (deleteConfirm.type === 'table') {
            await dsStore.deleteTable(deleteConfirm.dsId, deleteConfirm.tableId);
            tables.value = tables.value.filter((t) => t.id !== deleteConfirm.tableId);
            toast.success('数据表删除成功');
        }
        deleteConfirm.show = false;
    } catch (e: any) {
        toast.error('删除失败: ' + e.message);
    } finally {
        deleteSubmitting.value = false;
    }
}
</script>

<style scoped>
.ds-view {
    flex: 1;
    padding: 40px;
    overflow-y: auto;
    background: var(--da-bg);
}

.ds-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    margin-bottom: 48px;
}

.page-title {
    font-size: 28px;
    font-weight: 800;
    color: #fff;
    margin-bottom: 8px;
}

.page-subtitle {
    font-size: 14px;
    color: var(--da-text-muted);
}

.add-ds-btn {
    background: var(--da-primary);
    color: #fff;
    border: none;
    padding: 12px 24px;
    border-radius: 12px;
    font-weight: 600;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 10px;
    box-shadow: 0 4px 14px rgba(14, 165, 233, 0.3);
    transition: all 0.2s;
}

.add-ds-btn:hover {
    background: var(--da-primary-hover);
    transform: translateY(-2px);
}

.ds-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
    gap: 24px;
}

.empty-state {
    grid-column: 1 / -1;
    text-align: center;
    padding: 100px 0;
    color: var(--da-text-muted);
}

.empty-icon {
    font-size: 64px;
    margin-bottom: 24px;
    opacity: 0.2;
}

.skeleton-card {
    height: 260px;
    background: var(--da-panel);
    border-radius: 20px;
    position: relative;
    overflow: hidden;
}

.skeleton-card::after {
    content: '';
    position: absolute;
    inset: 0;
    background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.03), transparent);
    animation: shimmer 1.5s infinite;
}

@keyframes shimmer {
    0% {
        transform: translateX(-100%);
    }
    100% {
        transform: translateX(100%);
    }
}

.no-scrollbar::-webkit-scrollbar {
    display: none;
}
.no-scrollbar {
    -ms-overflow-style: none;
    scrollbar-width: none;
}
</style>
