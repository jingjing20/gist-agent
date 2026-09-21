<template>
    <main class="definitions">
        <header>
            <div>
                <h1>业务定义</h1>
                <p>按数据源管理已确认口径。修改在下一轮分析生效，历史版本会保留。</p>
            </div>
            <button :disabled="!canWrite || busy" @click="startEdit()">新增定义</button>
        </header>
        <section class="filters">
            <label
                >数据源<select v-model="datasourceId" :disabled="busy">
                    <option :value="0">请选择数据源</option>
                    <option v-for="ds in sources.list" :key="ds.id" :value="ds.id">{{ ds.name }}</option>
                </select></label
            >
            <label
                >类型<select v-model="type">
                    <option value="">全部类型</option>
                    <option value="metric">指标</option>
                    <option value="term">术语</option>
                    <option value="relationship">关系</option>
                </select></label
            >
            <label>搜索<input v-model="search" placeholder="名称、别名或含义" @keyup.enter="refresh" /></label
            ><button :disabled="!datasourceId || busy" @click="refresh">查询 / 刷新</button>
        </section>
        <p v-if="datasourceId && !canWrite">当前为只读；只有数据源所有者可以修改定义和确认候选。</p>
        <p v-if="error" role="alert" class="error">{{ error }}</p>
        <p v-if="loading">正在读取…</p>
        <section v-if="editing" class="editor">
            <h2>{{ editing.id ? '修改定义' : '新增定义' }}</h2>
            <p>保存即确认此口径，用于此数据源后续分析。</p>
            <label
                >类型<select v-model="form.type">
                    <option value="metric">指标</option>
                    <option value="term">术语</option>
                    <option value="relationship">关系</option>
                </select></label
            >
            <label>名称<input v-model="form.name" maxlength="200" /></label>
            <label>业务含义<textarea v-model="form.description" rows="3" /></label>
            <label>别名（每行一个）<textarea v-model="form.aliases" rows="2" /></label>
            <label>关联字段（每行一个，格式为 表名.字段名）<textarea v-model="form.relatedFields" rows="2" /></label>
            <div v-if="form.type === 'metric'" class="metric-grid">
                <label v-for="field in metricFields" :key="field.key">{{ field.label }}<input v-model="form.metric[field.key]" /></label>
            </div>
            <div v-if="form.type === 'relationship'" class="metric-grid">
                <label>左侧表字段<input v-model="form.relationship.leftField" /></label><label>右侧表字段<input v-model="form.relationship.rightField" /></label>
                <label
                    >预期基数<select v-model="form.relationship.cardinality">
                        <option value="one-to-one">一对一</option>
                        <option value="one-to-many">一对多</option>
                        <option value="many-to-one">多对一</option>
                        <option value="many-to-many">多对多</option>
                    </select></label
                >
                <label>关系说明<input v-model="form.relationship.explanation" /></label>
            </div>
            <div class="actions"><button :disabled="busy" @click="save">确认保存</button><button :disabled="busy" @click="editing = null">取消</button></div>
        </section>
        <section v-if="candidates.length">
            <h2>待确认候选</h2>
            <p>候选尚未进入正式定义。请检查完整内容后保存，或放弃。</p>
            <article v-for="candidate in candidates" :key="candidate.id">
                <h3>{{ candidate.content.name }}</h3>
                <p>{{ candidate.content.description }}</p>
                <p v-if="candidate.definitionId">修改现有定义 · 目标版本 {{ candidate.expectedVersion }}</p>
                <dl>
                    <template v-for="(value, key) in details(candidate.content)" :key="key"
                        ><dt>{{ key }}</dt>
                        <dd>{{ value }}</dd></template
                    >
                </dl>
                <div class="actions">
                    <button :disabled="busy" @click="decide(candidate, true)">保存到业务定义</button><button :disabled="busy" @click="decide(candidate, false)">放弃</button>
                </div>
            </article>
        </section>
        <section>
            <h2>已确认定义</h2>
            <p v-if="!loading && !items.length">暂无匹配的定义。</p>
            <article v-for="item in items" :key="item.id">
                <h3>
                    {{ item.name }} <small>{{ labels[item.type] }} · v{{ item.version }}</small>
                </h3>
                <p>{{ item.description }}</p>
                <p v-if="item.needsReview" class="error">引用字段已失效，需要检查；请修订后再用于分析。</p>
                <dl>
                    <template v-for="(value, key) in details(item)" :key="key"
                        ><dt>{{ key }}</dt>
                        <dd>{{ value }}</dd></template
                    >
                </dl>
                <div class="actions">
                    <button :disabled="!canWrite || busy" @click="startEdit(item)">修改</button><button :disabled="!canWrite || busy" @click="deleting = item">删除</button
                    ><button :disabled="busy" @click="openHistory(item)">历史版本</button>
                </div>
            </article>
            <button v-if="nextCursor" :disabled="loading || busy" @click="load(true)">加载更多</button>
        </section>
        <section v-if="deleting" class="editor" role="alertdialog" aria-label="确认删除定义">
            <p>删除“{{ deleting.name }}”后，后续分析不再默认使用；历史版本仍保留。</p>
            <button :disabled="busy" @click="remove">确认删除</button><button :disabled="busy" @click="deleting = null">取消</button>
        </section>
        <section v-if="history" class="editor">
            <h2>{{ history.name }} · 历史版本</h2>
            <label>版本<input v-model.number="historyVersion" type="number" min="1" :max="historyMax" /></label><button @click="readHistory">读取版本</button
            ><button @click="history = null">关闭</button>
            <p>{{ history.description }}</p>
            <p>v{{ history.version }} · {{ history.status === 'deleted' ? '已删除' : '有效记录' }}</p>
            <dl>
                <template v-for="(value, key) in details(history)" :key="key"
                    ><dt>{{ key }}</dt>
                    <dd>{{ value }}</dd></template
                >
            </dl>
        </section>
    </main>
</template>
<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { apiFetch } from '../api';
import { useDataSourceStore } from '../stores/datasource';
import { useAuthStore } from '../stores/auth';
import type { BusinessDefinition, BusinessDefinitionCandidate, BusinessDefinitionContent } from '@gist/contracts';
const sources = useDataSourceStore(),
    auth = useAuthStore();
const datasourceId = ref(0),
    type = ref(''),
    search = ref(''),
    error = ref(''),
    loading = ref(false),
    busy = ref(false);
const items = ref<BusinessDefinition[]>([]),
    candidates = ref<BusinessDefinitionCandidate[]>([]),
    nextCursor = ref<string | null>(null);
const editing = ref<{ id?: string; version?: number } | null>(null),
    deleting = ref<BusinessDefinition | null>(null),
    history = ref<BusinessDefinition | null>(null),
    historyVersion = ref(1),
    historyMax = ref(1);
const canWrite = computed(() => !!datasourceId.value && sources.list.find((s) => s.id === datasourceId.value)?.created_by === auth.user?.id);
const labels = { metric: '指标', term: '术语', relationship: '关系' };
const metricFields = [
    { key: 'numerator', label: '分子' },
    { key: 'denominator', label: '分母' },
    { key: 'entityGrain', label: '实体粒度' },
    { key: 'timeWindow', label: '时间窗口' },
    { key: 'timezone', label: '时区' },
    { key: 'unit', label: '单位' },
    { key: 'conditions', label: '适用条件' },
];
const form = reactive({
    type: 'term' as BusinessDefinitionContent['type'],
    name: '',
    description: '',
    aliases: '',
    relatedFields: '',
    metric: {} as Record<string, string>,
    relationship: { leftField: '', rightField: '', cardinality: 'one-to-many' as NonNullable<BusinessDefinitionContent['relationship']>['cardinality'], explanation: '' },
});
async function request(url: string, method = 'GET', body?: unknown) {
    const res = await apiFetch(url, { method, ...(body ? { body: JSON.stringify(body) } : {}) });
    if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        throw new Error(res.status === 409 ? '内容已变化或名称重复。请刷新后重新编辑 / 确认，当前内容未被覆盖。' : b.message || '操作失败');
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
        const q = new URLSearchParams({ datasourceId: String(ds), type: type.value, q: search.value, limit: '20' });
        if (more && nextCursor.value) q.set('cursor', nextCursor.value);
        const result = await request(`/business-definitions?${q}`);
        if (seq !== epoch) return;
        items.value = more ? [...items.value, ...result.items] : result.items;
        nextCursor.value = result.nextCursor;
        const pending = canWrite.value ? await request(`/business-definition-candidates?datasourceId=${ds}`) : [];
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
    deleting.value = null;
    history.value = null;
    loading.value = false;
    if (datasourceId.value) void refresh();
});
watch(type, refresh);
onMounted(async () => {
    await sources.fetchAll();
    if (sources.list.length) datasourceId.value = sources.list[0]!.id;
});
function startEdit(item?: BusinessDefinition) {
    editing.value = item ? { id: item.id, version: item.version } : {};
    Object.assign(form, {
        type: item?.type ?? 'term',
        name: item?.name ?? '',
        description: item?.description ?? '',
        aliases: item?.aliases?.join('\n') ?? '',
        relatedFields: item?.relatedFields?.join('\n') ?? '',
        metric: { ...item?.metric },
        relationship: item?.relationship ? { ...item.relationship } : { leftField: '', rightField: '', cardinality: 'one-to-many', explanation: '' },
    });
}
const lines = (s: string) =>
    s
        .split('\n')
        .map((x) => x.trim())
        .filter(Boolean);
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
function save() {
    if (!editing.value) return;
    const edit = editing.value;
    const content: BusinessDefinitionContent = {
        type: form.type,
        name: form.name,
        description: form.description,
        aliases: lines(form.aliases),
        relatedFields: lines(form.relatedFields),
        ...(form.type === 'metric' ? { metric: Object.fromEntries(Object.entries(form.metric).filter(([, v]) => v.trim())) } : {}),
        ...(form.type === 'relationship' ? { relationship: { ...form.relationship } } : {}),
    };
    return mutate(async () => {
        await request(edit.id ? `/business-definitions/${edit.id}` : '/business-definitions', edit.id ? 'PATCH' : 'POST', {
            ...content,
            ...(edit.id ? { expectedVersion: edit.version } : { datasourceId: datasourceId.value }),
        });
        editing.value = null;
    });
}
function remove() {
    const item = deleting.value;
    if (!item) return;
    return mutate(async () => {
        await request(`/business-definitions/${item.id}?expectedVersion=${item.version}`, 'DELETE');
        deleting.value = null;
    });
}
function decide(c: BusinessDefinitionCandidate, accept: boolean) {
    return mutate(() => request(`/business-definition-candidates/${c.id}/${accept ? 'confirm' : 'reject'}`, 'POST', { expectedVersion: c.version }));
}
function details(content: BusinessDefinitionContent) {
    return {
        类型: labels[content.type],
        别名: content.aliases?.join('、') || '无',
        关联字段: content.relatedFields?.join('、') || '无',
        ...Object.fromEntries(
            metricFields.filter((f) => content.metric?.[f.key as keyof typeof content.metric]).map((f) => [f.label, content.metric![f.key as keyof typeof content.metric]])
        ),
        ...(content.relationship
            ? {
                  左侧字段: content.relationship.leftField,
                  右侧字段: content.relationship.rightField,
                  预期基数: content.relationship.cardinality,
                  关系说明: content.relationship.explanation,
              }
            : {}),
    };
}
function openHistory(item: BusinessDefinition) {
    history.value = item;
    historyVersion.value = item.version;
    historyMax.value = item.version;
}
async function readHistory() {
    if (!history.value) return;
    const id = history.value.id,
        ds = datasourceId.value;
    try {
        const result = await request(`/business-definitions/${id}?version=${historyVersion.value}`);
        if (ds === datasourceId.value && history.value?.id === id) history.value = result;
    } catch (e) {
        error.value = (e as Error).message;
    }
}
</script>
<style scoped>
.definitions {
    width: 100%;
    overflow: auto;
    padding: 28px;
    max-width: 1200px;
    margin: auto;
    height: 100%;
    box-sizing: border-box;
}
header,
.filters,
.actions {
    display: flex;
    gap: 16px;
    align-items: center;
    flex-wrap: wrap;
}
header {
    justify-content: space-between;
}
h1 {
    margin: 0;
}
p {
    color: var(--da-text-muted);
    line-height: 1.6;
}
h2 {
    margin-top: 28px;
}
label {
    display: flex;
    flex-direction: column;
    gap: 7px;
    margin: 12px 0;
}
input,
textarea,
select,
button {
    font: inherit;
    padding: 9px 12px;
    border-radius: 6px;
    border: 1px solid var(--da-border);
    background: var(--da-bg);
    color: var(--da-text-main);
}
button {
    cursor: pointer;
}
button:disabled {
    opacity: 0.45;
    cursor: default;
}
article,
.editor {
    border: 1px solid var(--da-border);
    background: var(--da-panel);
    border-radius: 12px;
    padding: 20px;
    margin: 16px 0;
}
.metric-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: 12px;
}
.error {
    color: #f87171;
}
small {
    font-weight: normal;
    color: var(--da-text-muted);
}
dl {
    display: grid;
    grid-template-columns: 100px 1fr;
    gap: 8px;
}
dt {
    color: var(--da-text-muted);
}
dd {
    margin: 0;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
}
textarea {
    resize: vertical;
}
</style>
