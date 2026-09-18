<template>
    <div class="memory-overlay" @click.self="emit('close')">
        <section class="memory-panel">
            <header><div><h3>记忆管理</h3><p>查看、确认、纠正或忘记长期口径与偏好</p></div><button @click="emit('close')">×</button></header>
            <div v-if="loading" class="empty">加载中…</div>
            <div v-else-if="!records.length" class="empty">暂无长期记忆</div>
            <div v-else class="memory-list">
                <article v-for="item in records" :key="item.id" class="memory-card">
                    <div class="memory-title"><span>{{ typeLabel[item.type] }}</span><strong>{{ item.key }}</strong><em :class="item.status">{{ item.status === 'active' ? '已生效' : '待确认' }}</em></div>
                    <textarea v-if="editingId === item.id" v-model="editingValue" rows="5"></textarea>
                    <pre v-else>{{ JSON.stringify(item.value, null, 2) }}</pre>
                    <small v-if="item.sourceQuote">来源：“{{ item.sourceQuote }}”</small>
                    <div class="actions">
                        <button v-if="item.status === 'proposed'" class="primary" @click="confirm(item)">确认采用</button>
                        <template v-if="item.status === 'active'">
                            <button v-if="editingId !== item.id" @click="startEdit(item)">纠正</button>
                            <button v-else class="primary" @click="save(item)">保存</button>
                        </template>
                        <button class="danger" @click="forget(item)">忘记</button>
                    </div>
                </article>
            </div>
        </section>
    </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { apiFetch } from '../api';
import type { MemoryRecord } from '../types';
import { useToastStore } from '../stores/toast';

const emit = defineEmits<{ (event: 'close'): void }>();
const toast = useToastStore();
const loading = ref(true);
const records = ref<MemoryRecord[]>([]);
const editingId = ref<string | null>(null);
const editingValue = ref('');
const typeLabel = { metric_definition: '指标', dimension_definition: '维度', analysis_preference: '分析偏好', locale_preference: '地区偏好' };

async function load() {
    loading.value = true;
    const response = await apiFetch('/memories');
    if (!response.ok) throw new Error('记忆加载失败');
    records.value = await response.json();
    loading.value = false;
}
function startEdit(item: MemoryRecord) { editingId.value = item.id; editingValue.value = JSON.stringify(item.value, null, 2); }
async function confirm(item: MemoryRecord) { try { await mutate(`/${item.id}/confirm`, 'POST', { expectedVersion: item.version }); } catch (error) { toast.error((error as Error).message); } }
async function save(item: MemoryRecord) {
    try { await mutate(`/${item.id}`, 'PATCH', { expectedVersion: item.version, value: JSON.parse(editingValue.value) }); editingId.value = null; }
    catch (error) { toast.error(error instanceof SyntaxError ? '请输入合法 JSON' : (error as Error).message); }
}
async function forget(item: MemoryRecord) { try { await mutate(`/${item.id}`, 'DELETE', { expectedVersion: item.version }); } catch (error) { toast.error((error as Error).message); } }
async function mutate(path: string, method: string, body: object) {
    const response = await apiFetch(`/memories${path}`, { method, body: JSON.stringify(body) });
    if (!response.ok) { const detail = await response.json().catch(() => ({})); throw new Error(detail.message || '操作失败'); }
    toast.success('记忆已更新'); await load();
}
onMounted(() => void load().catch((error) => { loading.value = false; toast.error(error.message); }));
</script>

<style scoped>
.memory-overlay{position:fixed;inset:0;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;z-index:1000}.memory-panel{width:min(720px,92vw);max-height:82vh;overflow:auto;background:var(--da-panel);border:1px solid var(--da-border);border-radius:14px;padding:20px}.memory-panel header{display:flex;justify-content:space-between;align-items:flex-start}.memory-panel h3{margin:0}.memory-panel p{margin:6px 0 18px;color:var(--da-text-muted);font-size:13px}.memory-panel header button{background:none;border:0;color:var(--da-text-muted);font-size:24px;cursor:pointer}.memory-list{display:grid;gap:12px}.memory-card{border:1px solid var(--da-border);border-radius:10px;padding:14px}.memory-title{display:flex;gap:10px;align-items:center}.memory-title span,.memory-title em{font-size:11px;padding:3px 7px;border-radius:10px;background:var(--da-card);font-style:normal}.memory-title em{margin-left:auto}.memory-title em.proposed{color:#f59e0b}.memory-title em.active{color:#22c55e}pre,textarea{box-sizing:border-box;width:100%;margin:10px 0;padding:10px;background:var(--da-bg);color:var(--da-text-main);border:1px solid var(--da-border);border-radius:7px;white-space:pre-wrap}small{color:var(--da-text-muted)}.actions{display:flex;justify-content:flex-end;gap:8px;margin-top:12px}.actions button{padding:6px 10px;border:1px solid var(--da-border);border-radius:7px;background:var(--da-card);color:var(--da-text-main);cursor:pointer}.actions .primary{border-color:var(--da-primary);color:var(--da-primary)}.actions .danger{color:#ef4444}.empty{text-align:center;color:var(--da-text-muted);padding:36px}
</style>
