<template>
    <Dialog :open="!!modelValue" @update:open="(open) => !open && emit('update:modelValue', null)">
        <DialogContent class="sm:max-w-lg">
            <DialogHeader><DialogTitle>权限管理：{{ modelValue?.name }}</DialogTitle><DialogDescription>管理能访问此数据源的成员。</DialogDescription></DialogHeader>
            <div class="flex max-h-[65vh] flex-col gap-6 overflow-auto">
                <section class="flex flex-col gap-3">
                    <h3 class="text-sm font-medium">现有成员</h3>
                    <p v-if="!grantedUsers.length" class="text-sm text-muted-foreground">暂无成员</p>
                    <div v-for="user in grantedUsers" :key="user.id" class="flex items-center justify-between gap-3 rounded-md border border-border p-3">
                        <div class="min-w-0"><div class="truncate text-sm font-medium">{{ user.name }}</div><div class="truncate text-xs text-muted-foreground">{{ user.email }}</div></div>
                        <Badge v-if="user.id === authUser?.id" variant="secondary">所有者</Badge>
                        <Button v-else variant="outline" size="sm" @click="emit('revoke', user.id)">移除</Button>
                    </div>
                </section>
                <Field><FieldLabel for="member-search">添加成员</FieldLabel><Input id="member-search" v-model="searchQuery" placeholder="搜索邮箱或用户名" @input="handleSearch" /></Field>
                <div v-for="user in searchResults" :key="user.id" class="flex items-center justify-between gap-3 rounded-md border border-border p-3">
                    <div class="min-w-0"><div class="truncate text-sm font-medium">{{ user.name }}</div><div class="truncate text-xs text-muted-foreground">{{ user.email }}</div></div>
                    <Button v-if="!grantedUsers.some((member) => member.id === user.id) && user.id !== authUser?.id" variant="outline" size="sm" @click="emit('grant', user.id)">添加</Button>
                </div>
            </div>
        </DialogContent>
    </Dialog>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import type { DataSource } from '../../stores/datasource';

const props = defineProps<{
    modelValue: DataSource | null;
    grantedUsers: any[];
    searchResults: any[];
    authUser: any;
}>();

watch(
    () => props.modelValue,
    (val) => {
        if (val) {
            searchQuery.value = '';
            emit('search', '');
        }
    }
);

const emit = defineEmits<{
    (e: 'update:modelValue', value: DataSource | null): void;
    (e: 'search', query: string): void;
    (e: 'grant', userId: number): void;
    (e: 'revoke', userId: number): void;
}>();

const searchQuery = ref('');

function handleSearch() {
    emit('search', searchQuery.value);
}
</script>
