<template>
  <div class="ds-page">
    <div class="ds-header">
      <h2>数据源</h2>
      <div class="ds-actions">
        <button class="btn btn-primary" @click="showModeChooser = true">+ 新建数据源</button>
      </div>
    </div>

    <div class="ds-list">
      <div v-if="store.loading" class="ds-empty">加载中...</div>
      <div v-else-if="!store.list.length" class="ds-empty">暂无数据源，点击右上角添加</div>

      <div v-for="ds in store.list" :key="ds.id" class="ds-card">
        <div class="ds-card-header">
          <div class="ds-card-left">
            <div class="ds-info">
              <div class="ds-name">
                {{ ds.name }}
                <span v-if="ds.is_local" class="ds-local-tag">公共</span>
              </div>
              <div class="ds-meta">{{ ds.host }}:{{ ds.port }} / {{ ds.database_name }}</div>
            </div>
          </div>
          <div class="ds-card-right">
            <button v-if="!ds.is_local" class="btn btn-secondary btn-sm" @click="openUpload(ds)">上传文件</button>
            <template v-if="!ds.is_local">
              <button
                v-if="isCreator(ds)"
                class="btn btn-secondary btn-sm"
                @click="openGrant(ds)"
              >
                授权
              </button>
              <button class="btn btn-danger-ghost btn-sm" @click="handleDelete(ds.id)">删除</button>
            </template>
          </div>
        </div>
        <div v-if="expandedDs === ds.id" class="ds-tables">
          <template v-if="ds.is_local">
            <div class="ds-table-list">
              <div v-for="pt in PRESET_TABLES" :key="pt.tableName" class="ds-table-item ds-table-item--preset">
                <span class="ds-table-name">{{ pt.displayName }}</span>
                <span class="ds-table-meta">{{ pt.tableName }}</span>
              </div>
            </div>
          </template>
          <template v-else>
            <div v-if="tablesLoading" class="ds-tables-hint">加载中...</div>
            <div v-else-if="!tables.length" class="ds-tables-hint">暂无上传的表</div>
            <div v-else class="ds-table-list">
              <div v-for="t in tables" :key="t.id" class="ds-table-item">
                <span class="ds-table-name">{{ t.display_name }}</span>
                <span class="ds-table-meta">{{ t.table_name }}</span>
                <button class="btn btn-danger-ghost btn-xs" @click="handleDeleteTable(ds.id, t.id)">删除</button>
              </div>
            </div>
          </template>
        </div>
        <button class="ds-expand-btn" @click="toggleExpand(ds)">
          {{ expandedDs === ds.id ? '收起' : (ds.is_local ? '查看示例表' : '查看上传的表') }}
        </button>
      </div>
    </div>

    <!-- 新建数据源：选择模式 -->
    <div v-if="showModeChooser" class="modal-overlay" @click.self="showModeChooser = false">
      <div class="modal mode-chooser">
        <h3>新建数据源</h3>
        <p class="mode-desc">选择数据来源方式</p>
        <div class="mode-options">
          <button class="mode-option" @click="showModeChooser = false; showCreate = true">
            <div class="mode-icon">&#128268;</div>
            <div class="mode-label">配置数据库连接</div>
            <div class="mode-sub">连接已有的 MySQL 数据库</div>
          </button>
          <button class="mode-option" @click="showModeChooser = false; showCreateByFile = true">
            <div class="mode-icon">&#128196;</div>
            <div class="mode-label">上传文件新建</div>
            <div class="mode-sub">上传 CSV / XLSX 自动建表</div>
          </button>
        </div>
      </div>
    </div>

    <!-- 上传文件新建数据源弹窗 -->
    <div v-if="showCreateByFile" class="modal-overlay" @click.self="closeCreateByFile">
      <div class="modal">
        <h3>上传文件新建数据源</h3>
        <div class="form-row">
          <label>数据源名称</label>
          <input v-model="createFileForm.name" placeholder="例如：2024年销售数据" required />
        </div>
        <div class="form-row">
          <label>表名</label>
          <input v-model="createFileForm.displayName" placeholder="例如：销售明细" required />
        </div>
        <div
          class="upload-zone"
          :class="{ 'drag-over': createFileDragOver }"
          @dragover.prevent="createFileDragOver = true"
          @dragleave="createFileDragOver = false"
          @drop.prevent="handleCreateFileDrop"
          @click="createFileInputRef?.click()"
        >
          <input ref="createFileInputRef" type="file" accept=".csv,.xlsx,.xls" hidden @change="handleCreateFileChange" />
          <div v-if="createFileForm.file">
            <div class="upload-filename">{{ createFileForm.file.name }}</div>
            <div class="upload-hint">{{ (createFileForm.file.size / 1024).toFixed(1) }} KB</div>
          </div>
          <div v-else>
            <div class="upload-icon">+</div>
            <div class="upload-hint">点击或拖拽 CSV / XLSX / XLS 文件至此</div>
          </div>
        </div>
        <div v-if="createFileError" class="form-error">{{ createFileError }}</div>
        <div class="modal-footer">
          <button type="button" class="btn btn-ghost" @click="closeCreateByFile">取消</button>
          <button
            class="btn btn-primary"
            :disabled="!createFileForm.name || !createFileForm.displayName || !createFileForm.file || createFileSubmitting"
            @click="handleCreateByFile"
          >
            {{ createFileSubmitting ? '创建中...' : '创建数据源' }}
          </button>
        </div>
      </div>
    </div>

    <!-- 配置数据库连接弹窗 -->
    <div v-if="showCreate" class="modal-overlay" @click.self="showCreate = false">
      <div class="modal">
        <h3>添加 MySQL 数据源</h3>
        <form @submit.prevent="handleCreate">
          <div class="form-row">
            <label>名称</label>
            <input v-model="form.name" placeholder="我的线上库" required @input="connectionTested = false" />
          </div>
          <div class="form-row two-col">
            <div>
              <label>Host</label>
              <input v-model="form.host" placeholder="127.0.0.1" required @input="connectionTested = false" />
            </div>
            <div>
              <label>Port</label>
              <input v-model.number="form.port" type="number" placeholder="3306" required @input="connectionTested = false" />
            </div>
          </div>
          <div class="form-row two-col">
            <div>
              <label>用户名</label>
              <input v-model="form.user" placeholder="root" required @input="connectionTested = false" />
            </div>
            <div>
              <label>密码</label>
              <input v-model="form.password" type="password" placeholder="••••••" @input="connectionTested = false" />
            </div>
          </div>
          <div class="form-row">
            <label>数据库名</label>
            <input v-model="form.database_name" placeholder="my_database" required @input="connectionTested = false" />
          </div>
          <div class="form-row">
            <label>备注（可选）</label>
            <input v-model="form.description" placeholder="用途描述" />
          </div>
          <div v-if="connectionTested" class="form-success">连接成功，可新建数据源</div>
          <div v-if="formError" class="form-error">{{ formError }}</div>
          <div class="modal-footer">
            <button type="button" class="btn btn-ghost" @click="showCreate = false">取消</button>
            <button type="button" class="btn btn-secondary" :disabled="!canTestConnection || testingConnection" @click="handleTestConnection">
              {{ testingConnection ? '测试中...' : '测试连接' }}
            </button>
            <button type="submit" class="btn btn-primary" :disabled="!connectionTested || submitting">
              {{ submitting ? '创建中...' : '新建数据源' }}
            </button>
          </div>
        </form>
      </div>
    </div>

    <!-- 上传文件弹窗 -->
    <div v-if="showUpload" class="modal-overlay" @click.self="closeUpload">
      <div class="modal">
        <h3>上传数据文件到「{{ uploadTargetDs?.name }}」</h3>
        <div class="form-row">
          <label>表名</label>
          <input v-model="uploadDisplayName" placeholder="例如：2024年销售数据" required />
        </div>
        <div
          class="upload-zone"
          :class="{ 'drag-over': isDragOver }"
          @dragover.prevent="isDragOver = true"
          @dragleave="isDragOver = false"
          @drop.prevent="handleDrop"
          @click="fileInputRef?.click()"
        >
          <input ref="fileInputRef" type="file" accept=".csv,.xlsx,.xls" hidden @change="handleFileChange" />
          <div v-if="uploadFile">
            <div class="upload-filename">{{ uploadFile.name }}</div>
            <div class="upload-hint">{{ (uploadFile.size / 1024).toFixed(1) }} KB</div>
          </div>
          <div v-else>
            <div class="upload-icon">+</div>
            <div class="upload-hint">点击或拖拽 CSV / XLSX / XLS 文件至此</div>
          </div>
        </div>
        <div v-if="uploadError" class="form-error">{{ uploadError }}</div>
        <div class="modal-footer">
          <button type="button" class="btn btn-ghost" @click="closeUpload">取消</button>
          <button class="btn btn-primary" :disabled="!uploadFile || !uploadDisplayName || uploading" @click="handleUpload">
            {{ uploading ? '上传中...' : '上传' }}
          </button>
        </div>
      </div>
    </div>

    <!-- 授权弹窗 -->
    <div v-if="showGrant" class="modal-overlay" @click.self="closeGrant">
      <div class="modal" style="width: 420px">
        <h3>授权访问：{{ grantDs?.name }}</h3>
        <div v-if="grantedUsers.length" class="grant-section">
          <label>已授权用户</label>
          <div class="grant-results">
            <div
              v-for="u in grantedUsers"
              :key="u.id"
              class="grant-user-row"
            >
              <span>{{ u.email }} ({{ u.name }})</span>
              <span v-if="u.id === authStore.user?.id" class="grant-creator-tag">创建人</span>
              <button
                v-else
                class="btn btn-ghost btn-sm"
                @click="handleRevoke(u.id)"
              >
                撤销
              </button>
            </div>
          </div>
        </div>
        <div class="form-row">
          <label>搜索并授权新用户</label>
          <input
            v-model="grantSearch"
            placeholder="输入邮箱搜索"
            @input="debouncedSearch"
          />
        </div>
        <div v-if="grantSearchResults.length" class="grant-results">
          <div
            v-for="u in grantSearchResults"
            :key="u.id"
            class="grant-user-row"
          >
            <span>{{ u.email }} ({{ u.name }})</span>
            <span v-if="u.id === authStore.user?.id" class="grant-creator-tag">当前用户</span>
            <button
              v-else-if="grantedUsers.some(gu => gu.id === u.id)"
              class="btn btn-ghost btn-sm"
              @click="handleRevoke(u.id)"
            >
              撤销
            </button>
            <button
              v-else
              class="btn btn-primary btn-sm"
              @click="handleGrant(u.id)"
            >
              授权
            </button>
          </div>
        </div>
        <div v-else-if="grantSearch && !grantSearching" class="grant-hint">
          输入至少 2 个字符搜索
        </div>
        <div class="modal-footer">
          <button type="button" class="btn btn-ghost" @click="closeGrant">关闭</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, reactive, watch } from 'vue';
import { useDataSourceStore } from '../stores/datasource';
import { useAuthStore } from '../stores/auth';
import { apiFetch } from '../api';

const store = useDataSourceStore();
const authStore = useAuthStore();

function isCreator(ds: { created_by?: number | null }) {
  return ds.created_by === authStore.user?.id;
}

onMounted(() => store.fetchAll());

// 授权相关
const showGrant = ref(false);
const grantDs = ref<{ id: number; name: string } | null>(null);
const grantSearch = ref('');
const grantSearchResults = ref<{ id: number; email: string; name: string }[]>([]);
const grantSearching = ref(false);
const grantedUsers = ref<{ id: number; email: string; name: string }[]>([]);
let searchTimer: ReturnType<typeof setTimeout>;

function openGrant(ds: { id: number; name: string }) {
  grantDs.value = ds;
  grantSearch.value = '';
  grantSearchResults.value = [];
  grantedUsers.value = [];
  showGrant.value = true;
  loadPermissions();
}

function closeGrant() {
  showGrant.value = false;
  grantDs.value = null;
}

async function loadPermissions() {
  if (!grantDs.value) return;
  try {
    grantedUsers.value = await store.listPermissions(grantDs.value.id);
  } catch {
    grantedUsers.value = [];
  }
}

function debouncedSearch() {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    if (grantSearch.value.trim().length < 2) {
      grantSearchResults.value = [];
      return;
    }
    grantSearching.value = true;
    apiFetch(`/users/search?q=${encodeURIComponent(grantSearch.value)}`)
      .then(r => r.json())
      .then(data => { grantSearchResults.value = data; })
      .finally(() => { grantSearching.value = false; });
  }, 300);
}

async function handleGrant(userId: number) {
  if (!grantDs.value) return;
  try {
    await store.grant(grantDs.value.id, userId);
    await loadPermissions();
  } catch (e: any) {
    alert(e.message);
  }
}

async function handleRevoke(userId: number) {
  if (!grantDs.value) return;
  try {
    await store.revoke(grantDs.value.id, userId);
    await loadPermissions();
  } catch (e: any) {
    alert(e.message);
  }
}

// --- 新建数据源：模式选择 ---
const showModeChooser = ref(false);

// --- 上传文件新建数据源 ---
const showCreateByFile = ref(false);
const createFileSubmitting = ref(false);
const createFileError = ref('');
const createFileDragOver = ref(false);
const createFileInputRef = ref<HTMLInputElement | null>(null);
const createFileForm = reactive<{ name: string; displayName: string; file: File | null }>({
  name: '',
  displayName: '',
  file: null,
});

function closeCreateByFile() {
  showCreateByFile.value = false;
  createFileError.value = '';
  createFileDragOver.value = false;
  Object.assign(createFileForm, { name: '', displayName: '', file: null });
}

function handleCreateFileChange(e: Event) {
  const files = (e.target as HTMLInputElement).files;
  if (files?.[0]) createFileForm.file = files[0];
}

function handleCreateFileDrop(e: DragEvent) {
  createFileDragOver.value = false;
  const files = e.dataTransfer?.files;
  if (files?.[0]) createFileForm.file = files[0];
}

async function handleCreateByFile() {
  if (!createFileForm.name || !createFileForm.displayName || !createFileForm.file) return;
  createFileError.value = '';
  createFileSubmitting.value = true;
  let dsId: number | null = null;
  try {
    const ds = await store.create({ name: createFileForm.name });
    dsId = ds.id;
    await store.uploadTable(ds.id, createFileForm.file, createFileForm.displayName);
    closeCreateByFile();
  } catch (e: any) {
    if (dsId) {
      await store.remove(dsId).catch(() => {});
    }
    createFileError.value = e.message;
  } finally {
    createFileSubmitting.value = false;
  }
}

// --- 添加数据库 ---
const showCreate = ref(false);
const submitting = ref(false);
const testingConnection = ref(false);
const connectionTested = ref(false);
const formError = ref('');
const form = reactive({
  name: '',
  host: '127.0.0.1',
  port: 3306,
  user: 'root',
  password: '',
  database_name: '',
  description: '',
});

const canTestConnection = () =>
  !!form.name?.trim() && !!form.host?.trim() && form.port != null && !!form.user?.trim() && !!form.database_name?.trim();

function resetCreateForm() {
  connectionTested.value = false;
  formError.value = '';
  Object.assign(form, { name: '', host: '127.0.0.1', port: 3306, user: 'root', password: '', database_name: '', description: '' });
}

watch(showCreate, (v) => { if (v) resetCreateForm(); });

async function handleTestConnection() {
  if (!canTestConnection()) return;
  formError.value = '';
  testingConnection.value = true;
  try {
    await store.testConnection({
      host: form.host,
      port: form.port,
      user: form.user,
      password: form.password,
      database_name: form.database_name,
    });
    connectionTested.value = true;
  } catch (e: any) {
    formError.value = e.message;
  } finally {
    testingConnection.value = false;
  }
}

async function handleCreate() {
  if (!connectionTested.value) return;
  formError.value = '';
  submitting.value = true;
  try {
    await store.create({ ...form });
    showCreate.value = false;
    resetCreateForm();
  } catch (e: any) {
    formError.value = e.message;
  } finally {
    submitting.value = false;
  }
}

async function handleDelete(id: number) {
  if (!confirm('确认删除此数据源？')) return;
  try {
    await store.remove(id);
  } catch (e: any) {
    alert(e.message);
  }
}

// --- 上传文件 ---
const showUpload = ref(false);
const uploadTargetDs = ref<{ id: number; name: string } | null>(null);
const uploadDisplayName = ref('');
const uploadFile = ref<File | null>(null);
const uploadError = ref('');
const uploading = ref(false);
const isDragOver = ref(false);
const fileInputRef = ref<HTMLInputElement | null>(null);

function openUpload(ds: { id: number; name: string }) {
  uploadTargetDs.value = ds;
  uploadDisplayName.value = '';
  uploadFile.value = null;
  uploadError.value = '';
  showUpload.value = true;
}

function closeUpload() {
  showUpload.value = false;
  uploadTargetDs.value = null;
}

function handleFileChange(e: Event) {
  const files = (e.target as HTMLInputElement).files;
  if (files?.[0]) uploadFile.value = files[0];
}

function handleDrop(e: DragEvent) {
  isDragOver.value = false;
  const files = e.dataTransfer?.files;
  if (files?.[0]) uploadFile.value = files[0];
}

async function handleUpload() {
  if (!uploadFile.value || !uploadDisplayName.value || !uploadTargetDs.value) return;
  uploadError.value = '';
  uploading.value = true;
  try {
    await store.uploadTable(uploadTargetDs.value.id, uploadFile.value, uploadDisplayName.value);
    closeUpload();
    if (expandedDs.value === uploadTargetDs.value.id) {
      await loadTables(uploadTargetDs.value.id);
    }
  } catch (e: any) {
    uploadError.value = e.message;
  } finally {
    uploading.value = false;
  }
}

// --- 展开/收起表列表 ---
import type { DataSource, UploadedTable } from '../stores/datasource';

const PRESET_TABLES = [
  { tableName: 'platform_info', displayName: '平台信息' },
  { tableName: 'daily_active_stats', displayName: '日活统计' },
  { tableName: 'user_behavior_log', displayName: '用户行为日志' },
];

const expandedDs = ref<number | null>(null);
const tables = ref<UploadedTable[]>([]);
const tablesLoading = ref(false);

async function toggleExpand(ds: DataSource) {
  if (expandedDs.value === ds.id) {
    expandedDs.value = null;
    tables.value = [];
    return;
  }
  expandedDs.value = ds.id;
  if (ds.is_local) {
    tables.value = [];
    tablesLoading.value = false;
  } else {
    await loadTables(ds.id);
  }
}

async function loadTables(dsId: number) {
  tablesLoading.value = true;
  try {
    tables.value = await store.listTables(dsId);
  } catch {
    tables.value = [];
  } finally {
    tablesLoading.value = false;
  }
}

async function handleDeleteTable(dsId: number, tableId: number) {
  if (!confirm('确认删除此表？数据将无法恢复。')) return;
  try {
    await store.deleteTable(dsId, tableId);
    tables.value = tables.value.filter(t => t.id !== tableId);
  } catch (e: any) {
    alert(e.message);
  }
}
</script>

<style scoped>
.ds-page {
  flex: 1;
  display: flex;
  flex-direction: column;
  padding: 32px;
  overflow-y: auto;
  background: var(--bg-primary);
}

.ds-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 24px;
}

.ds-header h2 {
  font-size: 20px;
  font-weight: 600;
  color: var(--text-primary);
}

.ds-actions {
  display: flex;
  gap: 10px;
}

.ds-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
  max-width: 760px;
}

.ds-empty {
  color: var(--text-secondary);
  font-size: 14px;
  padding: 48px 0;
  text-align: center;
}

.ds-card {
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 16px 20px;
  transition: border-color 0.15s;
}

.ds-card:hover {
  border-color: var(--accent);
}

.ds-card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.ds-card-left {
  display: flex;
  align-items: center;
  gap: 14px;
}

.ds-card-right {
  display: flex;
  align-items: center;
  gap: 8px;
}

.ds-name {
  font-size: 15px;
  font-weight: 500;
  color: var(--text-primary);
}

.ds-meta {
  font-size: 12px;
  color: var(--text-secondary);
  margin-top: 2px;
}

.ds-local-tag {
  font-size: 10px;
  color: var(--accent);
  background: rgba(99, 102, 241, 0.1);
  padding: 2px 6px;
  border-radius: 4px;
  margin-left: 8px;
  vertical-align: middle;
}

/* 通用按钮 */
.btn {
  font-size: 13px;
  font-weight: 500;
  padding: 8px 16px;
  border-radius: 8px;
  border: none;
  cursor: pointer;
  transition: all 0.15s;
  font-family: inherit;
}

.btn-primary {
  background: var(--accent);
  color: #fff;
}

.btn-primary:hover:not(:disabled) {
  background: var(--accent-hover);
}

.btn-primary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.btn-secondary {
  background: var(--bg-hover);
  color: var(--text-primary);
  border: 1px solid var(--border);
}

.btn-secondary:hover {
  border-color: var(--accent);
}

.btn-ghost {
  background: transparent;
  color: var(--text-secondary);
  border: 1px solid var(--border);
}

.btn-ghost:hover {
  color: var(--text-primary);
}

.btn-danger-ghost {
  background: transparent;
  color: #f87171;
  border: 1px solid rgba(248, 113, 113, 0.3);
  font-size: 12px;
  padding: 5px 12px;
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.15s;
  font-family: inherit;
}

.btn-danger-ghost:hover {
  background: rgba(248, 113, 113, 0.1);
}

/* 弹窗 */
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
}

.modal {
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 16px;
  padding: 28px 32px;
  width: 480px;
  max-width: 90vw;
}

.modal h3 {
  font-size: 17px;
  font-weight: 600;
  color: var(--text-primary);
  margin-bottom: 20px;
}

.form-row {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 14px;
}

.form-row.two-col {
  flex-direction: row;
  gap: 12px;
}

.form-row.two-col > div {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.form-row label {
  font-size: 12px;
  color: var(--text-secondary);
  font-weight: 500;
}

.form-row input {
  background: var(--bg-primary);
  border: 1px solid var(--border);
  color: var(--text-primary);
  font-size: 13px;
  padding: 8px 12px;
  border-radius: 8px;
  outline: none;
  font-family: inherit;
  transition: border-color 0.15s;
}

.form-row input:focus {
  border-color: var(--accent);
}

.form-success {
  font-size: 12px;
  color: #22c55e;
  margin-bottom: 12px;
}

.form-error {
  font-size: 12px;
  color: #f87171;
  margin-bottom: 12px;
}

.modal-footer {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 20px;
}

/* 上传区 */
.upload-zone {
  border: 2px dashed var(--border);
  border-radius: 12px;
  padding: 36px 24px;
  text-align: center;
  cursor: pointer;
  transition: all 0.15s;
  margin: 14px 0;
}

.upload-zone:hover,
.upload-zone.drag-over {
  border-color: var(--accent);
  background: rgba(99, 102, 241, 0.05);
}

.upload-icon {
  font-size: 32px;
  color: var(--text-secondary);
  margin-bottom: 8px;
}

.upload-hint {
  font-size: 12px;
  color: var(--text-secondary);
}

.upload-filename {
  font-size: 14px;
  font-weight: 500;
  color: var(--text-primary);
  margin-bottom: 4px;
}

.grant-section {
  margin-bottom: 16px;
}

.grant-section label {
  font-size: 12px;
  color: var(--text-secondary);
  display: block;
  margin-bottom: 6px;
}

.grant-results {
  max-height: 200px;
  overflow-y: auto;
  margin: 12px 0;
  border: 1px solid var(--border);
  border-radius: 8px;
}

.grant-user-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  border-bottom: 1px solid var(--border);
  font-size: 13px;
}

.grant-user-row:last-child {
  border-bottom: none;
}

.grant-hint {
  font-size: 12px;
  color: var(--text-secondary);
  margin: 12px 0;
}

.grant-creator-tag {
  font-size: 11px;
  color: var(--text-secondary);
}

.btn-sm {
  padding: 4px 10px;
  font-size: 12px;
}

.btn-xs {
  padding: 2px 8px;
  font-size: 11px;
}

.ds-expand-btn {
  display: block;
  width: 100%;
  background: none;
  border: none;
  color: var(--text-secondary);
  font-size: 12px;
  padding: 10px 0 0;
  cursor: pointer;
  text-align: left;
  font-family: inherit;
}

.ds-expand-btn:hover {
  color: var(--accent);
}

.ds-tables {
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--border);
}

.ds-tables-hint {
  font-size: 12px;
  color: var(--text-secondary);
}

.ds-table-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.ds-table-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 10px;
  background: var(--bg-primary);
  border-radius: 6px;
  font-size: 13px;
}

.ds-table-name {
  color: var(--text-primary);
  font-weight: 500;
}

.ds-table-meta {
  color: var(--text-secondary);
  font-size: 11px;
  flex: 1;
}

/* 模式选择弹窗 */
.mode-chooser {
  width: 440px;
}

.mode-desc {
  font-size: 13px;
  color: var(--text-secondary);
  margin-bottom: 20px;
}

.mode-options {
  display: flex;
  gap: 12px;
}

.mode-option {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 24px 16px;
  background: var(--bg-primary);
  border: 1px solid var(--border);
  border-radius: 12px;
  cursor: pointer;
  transition: all 0.15s;
  font-family: inherit;
}

.mode-option:hover {
  border-color: var(--accent);
  background: rgba(99, 102, 241, 0.05);
}

.mode-icon {
  font-size: 28px;
}

.mode-label {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
}

.mode-sub {
  font-size: 12px;
  color: var(--text-secondary);
  text-align: center;
}
</style>
