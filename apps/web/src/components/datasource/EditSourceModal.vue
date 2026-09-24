<template>
    <Dialog :open="!!modelValue" @update:open="(open) => !open && emit('update:modelValue', null)">
        <DialogContent class="sm:max-w-lg">
            <DialogHeader><DialogTitle>编辑数据源</DialogTitle><DialogDescription>填写数据源名称和可选描述。</DialogDescription></DialogHeader>
            <FieldGroup>
                <Field><FieldLabel for="source-name">数据源名称</FieldLabel><Input id="source-name" v-model="form.name" placeholder="请输入数据源名称" /></Field>
                <Field><FieldLabel for="source-description">描述</FieldLabel><Textarea id="source-description" v-model="form.description" placeholder="请输入数据源描述（可选）" rows="3" /></Field>
            </FieldGroup>
            <p v-if="error" role="alert" class="text-sm text-destructive">{{ error }}</p>
            <DialogFooter><Button variant="outline" @click="emit('update:modelValue', null)">取消</Button><Button :disabled="!form.name || submitting" @click="handleSubmit">{{ submitting ? '保存中...' : '保存修改' }}</Button></DialogFooter>
        </DialogContent>
    </Dialog>
</template>

<script setup lang="ts">
import { reactive, watch } from 'vue';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import type { DataSource } from '../../stores/datasource';

const props = defineProps<{
    modelValue: DataSource | null;
    submitting: boolean;
    error?: string;
}>();

const emit = defineEmits<{
    (e: 'update:modelValue', value: DataSource | null): void;
    (e: 'submit', form: { name: string; description: string }): void;
}>();

const form = reactive({
    name: '',
    description: '',
});

watch(
    () => props.modelValue,
    (newVal) => {
        if (newVal) {
            form.name = newVal.name;
            form.description = newVal.description || '';
        }
    },
    { immediate: true }
);

function handleSubmit() {
    if (form.name) {
        emit('submit', { ...form });
    }
}
</script>
