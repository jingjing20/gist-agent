<template>
    <Dialog :open="modelValue" @update:open="(open) => !open && emit('update:modelValue', false)">
        <DialogContent class="sm:max-w-lg">
            <DialogHeader><DialogTitle>新建数据源</DialogTitle><DialogDescription>填写数据源名称和可选描述。</DialogDescription></DialogHeader>
            <FieldGroup>
                <Field><FieldLabel for="source-name">数据源名称</FieldLabel><Input id="source-name" v-model="form.name" placeholder="请输入数据源名称" /></Field>
                <Field><FieldLabel for="source-description">描述</FieldLabel><Textarea id="source-description" v-model="form.description" placeholder="请输入数据源描述（可选）" rows="3" /></Field>
            </FieldGroup>
            <p v-if="error" role="alert" class="text-sm text-destructive">{{ error }}</p>
            <DialogFooter><Button variant="outline" @click="emit('update:modelValue', false)">取消</Button><Button :disabled="!form.name || submitting" @click="handleSubmit">{{ submitting ? '创建中...' : '立即创建' }}</Button></DialogFooter>
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

const props = defineProps<{
    modelValue: boolean;
    submitting: boolean;
    error?: string;
}>();

const emit = defineEmits<{
    (e: 'update:modelValue', value: boolean): void;
    (e: 'submit', form: { name: string; description?: string }): void;
}>();

const form = reactive<{ name: string; description: string }>({
    name: '',
    description: '',
});

watch(
    () => props.modelValue,
    (val) => {
        if (val) {
            form.name = '';
            form.description = '';
        }
    }
);

function handleSubmit() {
    if (form.name) {
        emit('submit', { ...form });
    }
}
</script>
