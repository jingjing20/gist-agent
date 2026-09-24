<template>
    <Dialog :open="!!modelValue" @update:open="(open) => !open && emit('update:modelValue', null)">
        <DialogContent class="sm:max-w-2xl">
            <DialogHeader><DialogTitle>数据表列表：{{ modelValue?.name }}</DialogTitle><DialogDescription>查看当前数据源中的表。</DialogDescription></DialogHeader>
            <p v-if="loading" class="text-sm text-muted-foreground">加载中...</p>
            <p v-else-if="!tables.length" class="py-8 text-center text-sm text-muted-foreground">暂无数据表</p>
            <div v-else class="max-h-[60vh] overflow-auto">
                <Table>
                    <TableHeader><TableRow><TableHead>展示名</TableHead><TableHead>表名</TableHead><TableHead>上传者</TableHead><TableHead class="text-right">操作</TableHead></TableRow></TableHeader>
                    <TableBody>
                        <TableRow v-for="table in tables" :key="table.id">
                            <TableCell class="font-medium">{{ table.display_name }}</TableCell>
                            <TableCell class="text-muted-foreground">{{ table.table_name }}</TableCell>
                            <TableCell>{{ table.creator_name || '—' }}</TableCell>
                            <TableCell class="text-right"><Button v-if="modelValue && !modelValue.is_local && canDelete(modelValue, table)" variant="ghost" size="sm" @click="emit('delete-table', modelValue.id, table.id)">删除</Button></TableCell>
                        </TableRow>
                    </TableBody>
                </Table>
            </div>
        </DialogContent>
    </Dialog>
</template>

<script setup lang="ts">
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { DataSource, DataSourceTable } from '../../stores/datasource';
import { useAuthStore } from '../../stores/auth';

defineProps<{
    modelValue: DataSource | null;
    tables: DataSourceTable[];
    loading: boolean;
}>();

const authStore = useAuthStore();

const canDelete = (ds: DataSource, t: DataSourceTable) => {
    const uid = authStore.user?.id;
    if (!uid) return false;
    return t.source_type === 'uploaded' && (ds.created_by === uid || t.created_by === uid);
};

const emit = defineEmits<{
    (e: 'update:modelValue', value: DataSource | null): void;
    (e: 'delete-table', dsId: number, tableId: number): void;
}>();
</script>
