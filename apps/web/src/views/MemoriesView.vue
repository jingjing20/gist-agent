<template>
    <main class="memories-page h-full w-full overflow-auto bg-background px-6 py-10 text-foreground lg:px-14">
        <div class="mx-auto max-w-6xl">
            <header class="mb-8 flex flex-wrap items-start justify-between gap-6">
                <div>
                    <p class="mb-2 text-xs font-semibold tracking-widest text-primary">WORKSPACE / MEMORY</p>
                    <h1 class="mb-2 text-3xl font-semibold tracking-tight">记忆</h1>
                    <p class="text-sm leading-6 text-muted-foreground">按数据源管理已保存记忆。修改在下一轮分析生效，历史版本会保留。</p>
                </div>
                <Button :disabled="!canWrite || busy" class="mt-3" @click="startEdit()"><Plus class="size-4" />新增记忆</Button>
            </header>

            <section class="mb-9 flex flex-wrap items-end gap-4 rounded-xl border border-border bg-card p-5" aria-label="筛选记忆">
                <div class="grid w-full gap-2 sm:w-64">
                    <label id="source-label" class="text-sm font-medium">数据源</label>
                    <Select :model-value="datasourceId ? String(datasourceId) : undefined" :disabled="busy" @update:model-value="selectSource">
                        <SelectTrigger class="w-full" aria-labelledby="source-label"><SelectValue placeholder="请选择数据源" /></SelectTrigger>
                        <SelectContent class="memory-ui"
                            ><SelectGroup
                                ><SelectItem v-for="ds in sources.list" :key="ds.id" :value="String(ds.id)">{{ ds.name }}</SelectItem></SelectGroup
                            ></SelectContent
                        >
                    </Select>
                </div>
                <div class="grid w-full gap-2 sm:w-80">
                    <label for="memory-search" class="text-sm font-medium">搜索</label>
                    <div class="relative">
                        <Search class="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" /><Input
                            id="memory-search"
                            v-model="search"
                            class="pl-9"
                            placeholder="搜索标题或内容"
                            @keyup.enter="refresh"
                        />
                    </div>
                </div>
                <Button variant="secondary" :disabled="!datasourceId || busy" @click="refresh"><Search class="size-4" />查询</Button>
            </section>
            <p v-if="datasourceId && !canWrite" class="mb-6 rounded-lg border border-border p-3 text-sm text-muted-foreground">
                当前为只读；只有数据源所有者可以修改记忆和确认候选。
            </p>
            <p v-if="error" role="alert" class="mb-6 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">{{ error }}</p>

            <section v-if="candidates.length" class="mb-10">
                <div class="mb-4">
                    <h2 class="text-lg font-semibold">
                        待确认候选 <Badge variant="secondary">{{ candidates.length }}</Badge>
                    </h2>
                    <p class="mt-1 text-sm text-muted-foreground">检查完整内容后保存到记忆，或放弃候选。</p>
                </div>
                <div class="grid gap-3">
                    <MemoryCandidateCard
                        v-for="candidate in candidates"
                        :key="candidate.id"
                        :candidate="candidate"
                        :source-name="sources.list.find((source) => source.id === candidate.datasourceId)?.name"
                        :busy="busy"
                        @saved="refresh"
                        @reject="decide(candidate, false)"
                        @busy="busy = $event"
                    />
                </div>
            </section>

            <section>
                <div class="mb-4 flex items-center justify-between">
                    <div>
                        <h2 class="text-lg font-semibold">
                            已保存记忆 <Badge v-if="items.length" variant="secondary">{{ items.length }}{{ nextCursor ? '+' : '' }}</Badge>
                        </h2>
                        <p class="mt-1 text-sm text-muted-foreground">查看、修改和管理此数据源的记忆。</p>
                    </div>
                    <span v-if="loading" class="text-sm text-muted-foreground">正在读取…</span>
                </div>
                <div class="overflow-hidden rounded-xl border border-border bg-card">
                    <Table class="min-w-190 table-fixed"
                        ><TableHeader
                            ><TableRow class="bg-muted/50"
                                ><TableHead class="w-[19%] pl-5">标题</TableHead><TableHead class="w-[45%]">内容</TableHead><TableHead class="w-[9%]">版本</TableHead
                                ><TableHead class="w-[27%] pr-5 text-right">操作</TableHead></TableRow
                            ></TableHeader
                        >
                        <TableBody
                            ><TableRow v-for="item in items" :key="item.id"
                                ><TableCell class="wrap-break-word pl-5 font-medium whitespace-normal">{{ item.name }}</TableCell
                                ><TableCell class="text-muted-foreground whitespace-normal"
                                    ><span class="line-clamp-2 whitespace-pre-wrap wrap-break-word">{{ item.description }}</span></TableCell
                                ><TableCell
                                    ><Badge variant="outline">v{{ item.version }}</Badge></TableCell
                                ><TableCell class="pr-5"
                                    ><div class="flex justify-end gap-1">
                                        <Button variant="ghost" size="sm" @click="viewing = item">查看</Button
                                        ><Button variant="ghost" size="sm" :disabled="!canWrite || busy" @click="startEdit(item)">修改</Button
                                        ><Button variant="ghost" size="sm" :disabled="busy" @click="openHistory(item)">历史</Button
                                        ><Button variant="ghost" size="sm" class="text-destructive" :disabled="!canWrite || busy" @click="deleting = item">删除</Button>
                                    </div></TableCell
                                ></TableRow
                            >
                            <TableEmpty v-if="!loading && !items.length" :colspan="4"
                                ><div class="flex flex-col items-center gap-2 text-muted-foreground">
                                    <BookOpen class="size-7" /><strong class="text-foreground">{{ datasourceId ? '暂无匹配的记忆' : '请选择数据源' }}</strong
                                    ><span>{{ datasourceId ? '可以调整搜索词，或新增一条记忆。' : '选择数据源后查看和管理记忆。' }}</span>
                                </div></TableEmpty
                            >
                        </TableBody></Table
                    >
                    <div v-if="nextCursor" class="border-t border-border p-4 text-center">
                        <Button variant="outline" :disabled="loading || busy" @click="load(true)">加载更多</Button>
                    </div>
                </div>
            </section>
        </div>

        <Dialog :open="!!editing" @update:open="closeEditing"
            ><DialogContent class="memory-ui sm:max-w-xl"
                ><DialogHeader
                    ><DialogTitle>{{ editing?.id ? '修改记忆' : '新增记忆' }}</DialogTitle
                    ><DialogDescription>保存即确认这条记忆，用于此数据源后续分析。</DialogDescription></DialogHeader
                >
                <MemoryEditor
                    v-if="editing"
                    :datasource-id="datasourceId"
                    :content="form"
                    :memory-id="editing.id"
                    :expected-version="editing.version"
                    @saved="
                        editing = null;
                        refresh();
                    "
                    @cancel="editing = null"
                    @busy="busy = $event" /></DialogContent
        ></Dialog>
        <Dialog :open="!!viewing" @update:open="closeViewing"
            ><DialogContent class="memory-ui sm:max-w-xl"
                ><DialogHeader
                    ><DialogTitle>{{ viewing?.name }}</DialogTitle
                    ><DialogDescription>当前版本 v{{ viewing?.version }}</DialogDescription></DialogHeader
                >
                <div class="max-h-[50vh] overflow-auto whitespace-pre-wrap wrap-break-word text-sm leading-7">{{ viewing?.description }}</div>
                <DialogFooter
                    ><Button variant="outline" @click="viewing = null">关闭</Button><Button :disabled="!canWrite || busy" @click="editViewed">修改记忆</Button
                    ><Button
                        variant="destructive"
                        :disabled="!canWrite || busy"
                        @click="
                            deleting = viewing;
                            viewing = null;
                        "
                        >删除记忆</Button
                    ></DialogFooter
                ></DialogContent
            ></Dialog
        >
        <AlertDialog :open="!!deleting" @update:open="closeDeleting"
            ><AlertDialogContent class="memory-ui"
                ><AlertDialogHeader
                    ><AlertDialogTitle>删除记忆？</AlertDialogTitle
                    ><AlertDialogDescription>删除“{{ deleting?.name }}”后，后续分析不再默认使用；历史版本仍保留。</AlertDialogDescription></AlertDialogHeader
                ><AlertDialogFooter
                    ><AlertDialogCancel :disabled="busy">取消</AlertDialogCancel><Button variant="destructive" :disabled="busy" @click="remove">确认删除</Button></AlertDialogFooter
                ></AlertDialogContent
            ></AlertDialog
        >
        <Dialog :open="!!history" @update:open="closeHistory"
            ><DialogContent class="memory-ui sm:max-w-xl"
                ><DialogHeader
                    ><DialogTitle>{{ history?.name }} · 历史版本</DialogTitle><DialogDescription>选择版本查看当时保存的内容。</DialogDescription></DialogHeader
                >
                <div class="grid gap-4">
                    <div class="flex items-end gap-3">
                        <div class="grid w-28 gap-2">
                            <label for="history-version" class="text-sm font-medium">版本</label
                            ><Input id="history-version" v-model.number="historyVersion" type="number" min="1" :max="historyMax" />
                        </div>
                        <Button variant="outline" :disabled="busy" @click="readHistory">读取版本</Button>
                    </div>
                    <div class="flex items-center gap-2">
                        <Badge variant="outline">v{{ history?.version }}</Badge
                        ><span class="text-sm text-muted-foreground">{{ history?.status === 'deleted' ? '已删除' : '有效记录' }}</span>
                    </div>
                    <div class="max-h-[50vh] overflow-auto whitespace-pre-wrap wrap-break-word text-sm leading-7">{{ history?.description }}</div>
                </div>
                <DialogFooter><Button variant="outline" @click="history = null">关闭</Button></DialogFooter></DialogContent
            ></Dialog
        >
    </main>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import MemoryEditor from '../components/MemoryEditor.vue';
import MemoryCandidateCard from '../components/MemoryCandidateCard.vue';
import { useRoute } from 'vue-router';
import { Badge } from '@/components/ui/badge';
import { BookOpen, Plus, Search } from '@lucide/vue';
import { apiFetch } from '../api';
import { useDataSourceStore } from '../stores/datasource';
import { useAuthStore } from '../stores/auth';
import type { DatasourceMemory, MemoryCandidate } from '@gist/contracts';
const sources = useDataSourceStore(),
    auth = useAuthStore();
const route = useRoute();
const datasourceId = ref(0),
    search = ref(''),
    error = ref(''),
    loading = ref(false),
    busy = ref(false);
const items = ref<DatasourceMemory[]>([]),
    candidates = ref<MemoryCandidate[]>([]),
    nextCursor = ref<string | null>(null);
const editing = ref<{ id?: string; version?: number } | null>(null),
    viewing = ref<DatasourceMemory | null>(null),
    deleting = ref<DatasourceMemory | null>(null),
    history = ref<DatasourceMemory | null>(null),
    historyVersion = ref(1),
    historyMax = ref(1);
const canWrite = computed(() => !!datasourceId.value && sources.list.find((s) => s.id === datasourceId.value)?.created_by === auth.user?.id);
const form = reactive({ name: '', description: '' });
function closeEditing(open: boolean) {
    if (!open && !busy.value) editing.value = null;
}
function closeViewing(open: boolean) {
    if (!open) viewing.value = null;
}
function closeDeleting(open: boolean) {
    if (!open && !busy.value) deleting.value = null;
}
function closeHistory(open: boolean) {
    if (!open) history.value = null;
}
function selectSource(value: string | number | bigint | Record<string, unknown> | null | undefined) {
    datasourceId.value = Number(value || 0);
}
async function request(url: string, method = 'GET', body?: unknown) {
    const res = await apiFetch(url, { method, ...(body ? { body: JSON.stringify(body) } : {}) });
    if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        throw new Error(res.status === 409 ? '内容已变化或标题重复。请刷新后重新编辑 / 确认，当前内容未被覆盖。' : b.message || '操作失败');
    }
    return res.status === 204 ? null : res.json();
}
let epoch = 0;
async function load(more = false) {
    const ds = datasourceId.value,
        seq = ++epoch;
    if (!ds) return;
    loading.value = true;
    error.value = '';
    try {
        const q = new URLSearchParams({ datasourceId: String(ds), q: search.value, limit: '20' });
        if (more && nextCursor.value) q.set('cursor', nextCursor.value);
        const result = await request(`/memories?${q}`);
        if (seq !== epoch) return;
        items.value = more ? [...items.value, ...result.items] : result.items;
        nextCursor.value = result.nextCursor;
        const pending = canWrite.value ? await request(`/memory-candidates?datasourceId=${ds}`) : [];
        if (seq === epoch) candidates.value = pending;
    } catch (e) {
        if (seq === epoch) error.value = (e as Error).message;
    } finally {
        if (seq === epoch) loading.value = false;
    }
}
function refresh() {
    return load();
}
watch(datasourceId, () => {
    epoch++;
    items.value = [];
    candidates.value = [];
    nextCursor.value = null;
    editing.value = null;
    viewing.value = null;
    deleting.value = null;
    history.value = null;
    loading.value = false;
    if (datasourceId.value) void refresh();
});
onMounted(async () => {
    await sources.fetchAll();
    const requested = Number(route.query.datasourceId);
    datasourceId.value = sources.list.some((s) => s.id === requested) ? requested : (sources.list[0]?.id ?? 0);
    await openLinkedMemory();
});
async function openLinkedMemory() {
    const id = route.query.memoryId;
    if (typeof id !== 'string' || !datasourceId.value) return;
    const ds = datasourceId.value;
    try {
        const memory: DatasourceMemory = await request(`/memories/${encodeURIComponent(id)}`);
        if (datasourceId.value === ds && memory.datasourceId === ds && memory.status === 'active') viewing.value = memory;
    } catch (e) {
        if (datasourceId.value === ds) error.value = (e as Error).message;
    }
}
watch(
    () => [route.query.datasourceId, route.query.memoryId],
    async () => {
        const ds = Number(route.query.datasourceId);
        if (sources.list.some((s) => s.id === ds)) datasourceId.value = ds;
        await openLinkedMemory();
    }
);
function startEdit(item?: DatasourceMemory) {
    editing.value = item ? { id: item.id, version: item.version } : {};
    Object.assign(form, { name: item?.name ?? '', description: item?.description ?? '' });
}
function editViewed() {
    const item = viewing.value;
    if (!item) return;
    viewing.value = null;
    startEdit(item);
}
async function mutate(fn: () => Promise<unknown>) {
    busy.value = true;
    error.value = '';
    try {
        await fn();
        await refresh();
    } catch (e) {
        error.value = (e as Error).message;
    } finally {
        busy.value = false;
    }
}
function remove() {
    const item = deleting.value;
    if (!item) return;
    return mutate(async () => {
        await request(`/memories/${item.id}?expectedVersion=${item.version}`, 'DELETE');
        deleting.value = null;
    });
}
function decide(c: MemoryCandidate, accept: boolean) {
    return mutate(() => request(`/memory-candidates/${c.id}/${accept ? 'confirm' : 'reject'}`, 'POST', { expectedVersion: c.version }));
}
function openHistory(item: DatasourceMemory) {
    history.value = item;
    historyVersion.value = item.version;
    historyMax.value = item.version;
}
async function readHistory() {
    if (!history.value) return;
    const id = history.value.id,
        ds = datasourceId.value;
    try {
        const result = await request(`/memories/${id}?version=${historyVersion.value}`);
        if (ds === datasourceId.value && history.value?.id === id) history.value = result;
    } catch (e) {
        error.value = (e as Error).message;
    }
}
</script>
