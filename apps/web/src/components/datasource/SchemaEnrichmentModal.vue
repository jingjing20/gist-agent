<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { onBeforeRouteLeave } from 'vue-router';
import type { SchemaColumnComment, SchemaCommentSuggestion, SchemaEnrichmentResult } from '@gist/contracts';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Textarea } from '@/components/ui/textarea';
import { Field, FieldGroup, FieldLabel, FieldDescription } from '@/components/ui/field';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Table, TableHeader, TableHead, TableRow, TableBody, TableCell } from '@/components/ui/table';
import ConfirmModal from '../ConfirmModal.vue';
import { apiFetch } from '../../api';
import { useDataSourceStore, type DataSourceTable } from '../../stores/datasource';

const props = defineProps<{ table: DataSourceTable | null }>();
const emit = defineEmits<{ close: []; saved: [] }>();
const store = useDataSourceStore();
const columns = ref<SchemaColumnComment[]>([]);
const selected = ref<string[]>([]);
const suggestions = ref<Array<SchemaCommentSuggestion & { selected: boolean }>>([]);
const busy = ref(false),
    error = ref(''),
    notice = ref(''),
    confirmClose = ref(false);
const unsaved = computed(() => suggestions.value.length > 0);
const chosen = computed(() => suggestions.value.filter((s) => s.selected));
let epoch = 0;
const path = () => `/datasources/${props.table!.datasource_id}/tables/${props.table!.id}/column-comments`;
async function request<T>(url: string, method = 'GET', body?: unknown): Promise<T> {
    const response = await apiFetch(url, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || '操作失败，请重试');
    return data;
}
watch(
    () => props.table,
    async (table) => {
        const current = ++epoch;
        columns.value = [];
        selected.value = [];
        suggestions.value = [];
        error.value = '';
        notice.value = '';
        if (!table) return;
        busy.value = true;
        try {
            const result = await request<SchemaColumnComment[]>(path());
            if (current !== epoch) return;
            columns.value = result;
            selected.value = result
                .filter((c) => !c.comment.trim())
                .slice(0, 100)
                .map((c) => c.name);
        } catch (e) {
            if (current === epoch) error.value = (e as Error).message;
        } finally {
            if (current === epoch) busy.value = false;
        }
    },
    { immediate: true }
);
function toggle(name: string, checked: boolean | 'indeterminate') {
    selected.value = checked === true ? [...selected.value, name] : selected.value.filter((n) => n !== name);
}
async function generate() {
    if (!props.table || busy.value) return;
    busy.value = true;
    error.value = '';
    notice.value = '';
    try {
        const result = await request<SchemaEnrichmentResult>(`${path()}/suggestions`, 'POST', { columns: selected.value });
        for (const column of result.columns) {
            const index = columns.value.findIndex((c) => c.name === column.name);
            if (index >= 0) columns.value[index] = column;
        }
        suggestions.value = result.suggestions.map((s) => ({ ...s, selected: false }));
        if (!suggestions.value.length) notice.value = '没有可靠的补充建议，正式注释未修改。';
    } catch (e) {
        error.value = (e as Error).message;
    } finally {
        busy.value = false;
    }
}
async function refreshOriginals() {
    busy.value = true;
    error.value = '';
    try {
        columns.value = await request<SchemaColumnComment[]>(path());
        suggestions.value.forEach((s) => {
            s.selected = false;
        });
        notice.value = '已刷新当前正式注释，保留了你的建议编辑。请重新对照并选择写入项。';
    } catch (e) {
        error.value = (e as Error).message;
    } finally {
        busy.value = false;
    }
}
async function save() {
    busy.value = true;
    error.value = '';
    notice.value = '';
    try {
        const changes = chosen.value.map((s) => ({
            column: s.column,
            comment: s.suggestedComment,
            originalComment: columns.value.find((c) => c.name === s.column)?.comment ?? '',
        }));
        columns.value = await request<SchemaColumnComment[]>(path(), 'PATCH', { changes });
        const saved = new Set(changes.map((s) => s.column));
        suggestions.value = suggestions.value.filter((s) => !saved.has(s.column));
        store.invalidateSuggestions(props.table!.datasource_id);
        notice.value = `已保存 ${changes.length} 个字段注释。`;
        emit('saved');
    } catch (e) {
        error.value = (e as Error).message;
    } finally {
        busy.value = false;
    }
}
function close() {
    if (busy.value) return;
    if (unsaved.value) confirmClose.value = true;
    else emit('close');
}
function beforeUnload(event: BeforeUnloadEvent) {
    if (unsaved.value || busy.value) {
        event.preventDefault();
        event.returnValue = '';
    }
}
onBeforeRouteLeave(() => {
    if (busy.value) return false;
    if (unsaved.value) {
        confirmClose.value = true;
        return false;
    }
    return true;
});
window.addEventListener('beforeunload', beforeUnload);
onBeforeUnmount(() => {
    epoch++;
    window.removeEventListener('beforeunload', beforeUnload);
});
</script>

<template>
    <Dialog :open="!!table" @update:open="(open) => !open && close()">
        <DialogContent class="sm:max-w-5xl" :show-close-button="!busy">
            <DialogHeader>
                <DialogTitle>字段注释增强：{{ table?.display_name }}</DialogTitle>
                <DialogDescription>选择字段生成建议，逐项核对和编辑后再保存。生成建议不会修改正式注释。</DialogDescription>
            </DialogHeader>
            <p v-if="error" role="alert" class="text-destructive">{{ error }}</p>
            <p v-if="notice" role="status" class="text-muted-foreground">{{ notice }}</p>
            <div class="max-h-[60vh] overflow-auto">
                <template v-if="!suggestions.length">
                    <div class="mb-3 flex gap-2">
                        <Button variant="outline" size="sm" :disabled="busy" @click="selected = columns.slice(0, 100).map((c) => c.name)">选择全部字段（最多 100 个）</Button>
                        <Button variant="ghost" size="sm" :disabled="busy" @click="selected = []">清空选择</Button>
                    </div>
                    <Table>
                        <TableHeader
                            ><TableRow><TableHead>选择</TableHead><TableHead>字段</TableHead><TableHead>类型</TableHead><TableHead>当前注释</TableHead></TableRow></TableHeader
                        >
                        <TableBody
                            ><TableRow v-for="column in columns" :key="column.name">
                                <TableCell
                                    ><Checkbox
                                        :aria-label="`选择字段 ${column.name}`"
                                        :model-value="selected.includes(column.name)"
                                        :disabled="busy || (!selected.includes(column.name) && selected.length >= 100)"
                                        @update:model-value="(value) => toggle(column.name, value)"
                                /></TableCell>
                                <TableCell>{{ column.name }}</TableCell
                                ><TableCell>{{ column.type }}</TableCell
                                ><TableCell class="whitespace-normal">{{ column.comment || '暂无注释' }}</TableCell>
                            </TableRow></TableBody
                        >
                    </Table>
                </template>
                <FieldGroup v-else>
                    <Button variant="outline" size="sm" :disabled="busy" @click="suggestions.forEach((s) => (s.selected = true))">选择全部建议</Button>
                    <Field v-for="(item, index) in suggestions" :key="item.column">
                        <FieldLabel :for="`suggestion-${index}`">
                            <Checkbox v-model="item.selected" :disabled="busy" :aria-label="`保存 ${item.column} 的注释`" />{{ item.column }}
                        </FieldLabel>
                        <FieldDescription>当前注释：{{ columns.find((c) => c.name === item.column)?.comment || '暂无注释' }}</FieldDescription>
                        <Textarea :id="`suggestion-${index}`" v-model="item.suggestedComment" :disabled="busy" :maxlength="1000" :aria-label="`${item.column} 建议注释`" />
                        <FieldDescription>依据：{{ item.basis === 'original_metadata' ? '原有元数据' : '有限样本观察' }}</FieldDescription>
                        <FieldDescription v-if="item.needsVerification.length">待核实：{{ item.needsVerification.join('；') }}。这些事项不会自动写入正式注释。</FieldDescription>
                    </Field>
                </FieldGroup>
            </div>
            <DialogFooter>
                <Button variant="ghost" :disabled="busy" @click="close">关闭</Button>
                <Button v-if="suggestions.length" variant="outline" :disabled="busy" @click="refreshOriginals">刷新原注释并重新核对</Button>
                <Button v-if="!suggestions.length" :disabled="busy || !selected.length" @click="generate">{{ busy ? '处理中…' : `为 ${selected.length} 个字段生成建议` }}</Button>
                <Button v-else :disabled="busy || !chosen.length || chosen.some((s) => !s.suggestedComment.trim())" @click="save">{{
                    busy ? '处理中…' : `保存选中的 ${chosen.length} 个字段注释`
                }}</Button>
            </DialogFooter>
        </DialogContent>
    </Dialog>
    <ConfirmModal
        v-model="confirmClose"
        title="放弃未保存的注释建议？"
        desc="已保存的正式注释不受影响，未保存建议关闭后不会保留。"
        confirm-text="放弃并关闭"
        @confirm="
            confirmClose = false;
            emit('close');
        "
    />
</template>
