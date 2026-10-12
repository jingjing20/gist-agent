<template>
    <form class="flex flex-col gap-4" @submit.prevent="save">
        <FieldGroup>
            <Field>
                <FieldLabel :for="`${uid}-name`">标题</FieldLabel>
                <Input :id="`${uid}-name`" v-model="form.name" required maxlength="200" :disabled="busy || disabled" />
            </Field>
            <Field>
                <FieldLabel :for="`${uid}-description`">记忆内容</FieldLabel>
                <Textarea :id="`${uid}-description`" v-model="form.description" required maxlength="4000" :rows="5" :disabled="busy || disabled" />
                <FieldDescription>只保存可复用的业务口径，请移除本轮查询、画图等请求。</FieldDescription>
            </Field>
        </FieldGroup>
        <section v-if="matches.length" class="flex max-h-64 flex-col gap-3 overflow-auto" aria-label="相似记忆核对">
            <p role="status" class="text-sm text-muted-foreground">发现同名或相似内容，请核对是否重复或口径冲突。文字匹配不代表业务矛盾。</p>
            <details v-for="match in matches" :key="match.memory.id" class="text-sm">
                <summary>{{ match.memory.name }} · v{{ match.memory.version }} · {{ reasons[match.reason] }}</summary>
                <MemoryContent :content="match.memory" />
                <Button type="button" variant="outline" size="sm" :disabled="busy || disabled" @click="target = match.memory">替换这条记忆</Button>
            </details>
        </section>
        <p v-if="target" class="text-sm text-muted-foreground">
            将替换“{{ target.name }}”的 v{{ target.version }}，历史版本保留。
            <Button v-if="!memoryId" type="button" variant="ghost" size="sm" :disabled="busy || disabled" @click="target = null">改为新增</Button>
        </p>
        <p v-else-if="memoryId" class="text-sm text-muted-foreground">将修改已有记忆 v{{ expectedVersion }}，版本变化时会拒绝覆盖。</p>
        <p v-else class="text-sm text-muted-foreground">将新增一条记忆，保存后用于后续分析。</p>
        <p v-if="error" role="alert" class="text-sm text-destructive">{{ error }}</p>
        <div class="flex flex-wrap justify-end gap-2">
            <Button type="button" variant="outline" :disabled="busy || disabled" @click="$emit('cancel')">取消</Button>
            <Button type="submit" :disabled="busy || disabled">{{ busy ? '正在检查并保存…' : reviewed ? (target || memoryId ? '确认替换' : '仍然新增') : '检查并保存' }}</Button>
        </div>
    </form>
</template>
<script setup lang="ts">
import { onBeforeUnmount, reactive, ref, useId, watch } from 'vue';
import type { DatasourceMemory, MemoryContent as Content, RelatedMemory } from '@gist/contracts';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { apiFetch } from '../api';
import MemoryContent from './MemoryContent.vue';

const props = defineProps<{
    datasourceId: number;
    content: Content;
    memoryId?: string;
    expectedVersion?: number;
    candidateId?: string;
    candidateVersion?: number;
    disabled?: boolean;
}>();
const emit = defineEmits<{ saved: [result: { name: string; version: number }]; cancel: []; busy: [value: boolean] }>();
const uid = useId();
const form = reactive({ ...props.content });
const busy = ref(false),
    error = ref(''),
    reviewed = ref('');
const matches = ref<RelatedMemory[]>([]),
    target = ref<DatasourceMemory | null>(null);
const reasons = { same_name: '标题相同', same_content: '内容相同', similar_content: '文字相似' };
let contextRevision = 0;
onBeforeUnmount(() => contextRevision++);
watch(
    () => [form.name, form.description],
    () => {
        reviewed.value = '';
        matches.value = [];
        target.value = null;
    }
);
watch(
    () => [props.datasourceId, props.memoryId, props.candidateId, props.content],
    () => {
        contextRevision++;
        Object.assign(form, props.content);
        matches.value = [];
        target.value = null;
        reviewed.value = '';
        error.value = '';
    }
);
async function request(url: string, method: string, body: unknown) {
    const response = await apiFetch(url, { method, body: JSON.stringify(body) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.message || '操作失败，请重试');
    return data;
}
async function save() {
    if (busy.value || props.disabled) return;
    busy.value = true;
    emit('busy', true);
    error.value = '';
    const content = { name: form.name.trim(), description: form.description.trim() };
    const revision = contextRevision;
    try {
        const current: RelatedMemory[] = await request('/memories/related', 'POST', {
            datasourceId: props.datasourceId,
            content,
            excludeId: props.memoryId,
        });
        if (revision !== contextRevision) return;
        const fingerprint = JSON.stringify({ content, matches: current.map((m) => [m.memory.id, m.memory.version, m.reason]) });
        matches.value = current;
        if (current.length && reviewed.value !== fingerprint) {
            reviewed.value = fingerprint;
            return;
        }
        const memoryId = target.value?.id ?? props.memoryId;
        const version = target.value?.version ?? props.expectedVersion;
        let result;
        if (props.candidateId) {
            result = await request(`/memory-candidates/${props.candidateId}/confirm`, 'POST', {
                expectedVersion: props.candidateVersion,
                content,
                ...(memoryId ? { memoryId, expectedMemoryVersion: version } : {}),
            });
        } else {
            result = await request(memoryId ? `/memories/${memoryId}` : '/memories', memoryId ? 'PATCH' : 'POST', {
                ...content,
                ...(memoryId ? { expectedVersion: version } : { datasourceId: props.datasourceId }),
            });
        }
        emit('saved', { name: content.name, version: result.version });
    } catch (e) {
        error.value = (e as Error).message;
        reviewed.value = '';
    } finally {
        busy.value = false;
        emit('busy', false);
    }
}
</script>
