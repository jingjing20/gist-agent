<template>
    <Card class="h-full">
        <CardHeader>
            <div class="flex items-center justify-between gap-3"><Badge variant="secondary">{{ ds.is_local ? '公共数据库' : '文件数据源' }}</Badge></div>
            <CardTitle class="truncate" :title="ds.name">{{ ds.name }}</CardTitle>
            <CardDescription class="line-clamp-2 min-h-10" :title="ds.description || '无描述'">{{ ds.description || '通过文件上传创建的数据分析源' }}</CardDescription>
        </CardHeader>
        <CardContent class="flex flex-col gap-2 text-sm">
            <div class="flex justify-between gap-3"><span class="text-muted-foreground">最后更新</span><span>{{ formattedDate }}</span></div>
            <div class="flex justify-between gap-3"><span class="text-muted-foreground">所有者</span><span>{{ ownerName }}</span></div>
        </CardContent>
        <CardFooter class="flex flex-wrap gap-2">
            <Button v-if="!ds.is_local && isCreator" variant="outline" size="icon-sm" aria-label="编辑信息" @click="emit('edit', ds)"><Edit /></Button>
            <Button v-if="!ds.is_local" variant="outline" size="icon-sm" aria-label="上传文件" @click="emit('upload', ds)"><FileUp /></Button>
            <Button v-if="!ds.is_local && isCreator" variant="outline" size="icon-sm" aria-label="授权管理" @click="emit('grant', ds)"><Shield /></Button>
            <Button variant="outline" size="icon-sm" aria-label="查看数据表" @click="emit('view-tables', ds)"><Table2 /></Button>
            <Button v-if="!ds.is_local && isCreator" variant="outline" size="icon-sm" aria-label="删除数据源" @click="emit('delete', ds.id)"><Trash2 /></Button>
        </CardFooter>
    </Card>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Edit, FileUp, Shield, Table2, Trash2 } from '@lucide/vue';
import { useAuthStore } from '../../stores/auth';
import type { DataSource } from '../../stores/datasource';

const props = defineProps<{
    ds: DataSource;
}>();

const emit = defineEmits<{
    (e: 'upload', ds: DataSource): void;
    (e: 'edit', ds: DataSource): void;
    (e: 'grant', ds: DataSource): void;
    (e: 'view-tables', ds: DataSource): void;
    (e: 'delete', id: number): void;
}>();

const authStore = useAuthStore();

const isCreator = computed(() => {
    return props.ds.created_by === authStore.user?.id;
});

const ownerName = computed(() => {
    if (props.ds.is_local) return 'System';
    if (isCreator.value) return `${props.ds.creator_name || '我'} (我)`;
    return props.ds.creator_name || '未知用户';
});

const formattedDate = computed(() => {
    const dateStr = props.ds.created_at;
    if (!dateStr) return '-';
    const date = new Date(dateStr);
    return `${date.getMonth() + 1}/${date.getDate()} ${date.getHours()}:${String(date.getMinutes()).padStart(2, '0')}`;
});
</script>
