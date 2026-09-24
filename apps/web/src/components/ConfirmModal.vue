<template>
    <AlertDialog :open="modelValue" @update:open="onOpenChange">
        <AlertDialogContent>
            <AlertDialogHeader>
                <AlertDialogTitle>{{ title }}</AlertDialogTitle>
                <AlertDialogDescription>{{ desc }}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
                <AlertDialogCancel>取消</AlertDialogCancel>
                <Button variant="destructive" :disabled="loading" @click="handleConfirm">{{ loading ? loadingText || '处理中...' : confirmText || '确认' }}</Button>
            </AlertDialogFooter>
        </AlertDialogContent>
    </AlertDialog>
</template>

<script setup lang="ts">
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';

const props = defineProps<{
    modelValue: boolean;
    title: string;
    desc: string;
    loading?: boolean;
    loadingText?: string;
    confirmText?: string;
}>();
const emit = defineEmits<{
    (e: 'update:modelValue', value: boolean): void;
    (e: 'confirm'): void;
    (e: 'cancel'): void;
}>();
function handleCancel() {
    emit('update:modelValue', false);
    emit('cancel');
}
function handleConfirm() {
    emit('confirm');
}
function onOpenChange(open: boolean) {
    if (!open && props.modelValue) handleCancel();
}
</script>
