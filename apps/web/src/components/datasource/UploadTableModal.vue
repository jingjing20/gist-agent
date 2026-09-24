<template>
    <Dialog :open="!!modelValue" @update:open="(open) => !open && emit('update:modelValue', null)">
        <DialogContent :class="file && isExcel ? 'sm:max-w-3xl' : 'sm:max-w-lg'">
            <DialogHeader><DialogTitle>上传数据到「{{ modelValue?.name }}」</DialogTitle><DialogDescription>支持 CSV、XLSX 和 XLS 文件，可选择需要导入的 Sheet。</DialogDescription></DialogHeader>
            <div class="flex max-h-[65vh] flex-col gap-5 overflow-auto">
                <div v-if="!file" class="flex min-h-40 cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border p-6 text-center hover:bg-accent" :class="{ 'bg-accent': dragOver }" role="button" tabindex="0" @dragover.prevent="dragOver = true" @dragleave="dragOver = false" @drop.prevent="handleDrop" @click="fileInputRef?.click()" @keydown.enter="fileInputRef?.click()">
                    <input ref="fileInputRef" type="file" accept=".csv,.xlsx,.xls" hidden @change="handleChange" />
                    <p class="font-medium">点击或拖拽文件到这里</p><p class="text-sm text-muted-foreground">支持 .csv、.xlsx、.xls</p>
                </div>
                <template v-else>
                    <div class="flex items-center justify-between gap-3 rounded-lg border border-border p-3"><div class="min-w-0"><p class="truncate font-medium">{{ file.name }}</p><p class="text-xs text-muted-foreground">{{ (file.size / 1024).toFixed(1) }} KB</p></div><Button variant="outline" size="sm" @click="resetFile">修改文件</Button></div>
                    <section class="flex flex-col gap-3"><h3 class="text-sm font-medium">确认表名称（{{ tableConfigs.filter((config) => config.selected).length }} / {{ tableConfigs.length }}）</h3>
                        <div v-for="(config, index) in tableConfigs" :key="index" class="flex flex-wrap items-center gap-3 rounded-lg border border-border p-3">
                            <Checkbox :id="`sheet-${index}`" :model-value="config.selected" :disabled="tableConfigs.length === 1 && config.selected" @update:model-value="(value) => config.selected = value === true" />
                            <Badge v-if="isExcel" variant="secondary">{{ config.sheetName }}</Badge>
                            <Field class="min-w-40 flex-1"><FieldLabel :for="`name-${index}`" class="sr-only">表展示名</FieldLabel><Input :id="`name-${index}`" v-model="config.displayName" placeholder="输入表展示名" /></Field>
                        </div>
                    </section>
                </template>
                <p v-if="error" role="alert" class="text-sm text-destructive">{{ error }}</p>
            </div>
            <DialogFooter><Button variant="outline" @click="emit('update:modelValue', null)">取消</Button><Button :disabled="!file || !canSubmit || submitting" @click="handleSubmit">{{ submitting ? '上传中...' : '开始上传' }}</Button></DialogFooter>
        </DialogContent>
    </Dialog>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import type { DataSource } from '../../stores/datasource';
import * as XLSX from 'xlsx';

const props = defineProps<{
    modelValue: DataSource | null;
    submitting: boolean;
    error?: string;
}>();

const emit = defineEmits<{
    (e: 'update:modelValue', value: DataSource | null): void;
    (e: 'submit', dsId: number, file: File, configs: { sheetName?: string; displayName: string }[]): void;
}>();

const dragOver = ref(false);
const fileInputRef = ref<HTMLInputElement | null>(null);
const file = ref<File | null>(null);

interface TableConfig {
    sheetName?: string;
    displayName: string;
    selected: boolean;
}
const tableConfigs = ref<TableConfig[]>([]);

const isExcel = computed(() => {
    if (!file.value) return false;
    const ext = file.value.name.split('.').pop()?.toLowerCase();
    return ext === 'xlsx' || ext === 'xls';
});

const canSubmit = computed(() => {
    return tableConfigs.value.some((c) => c.selected && c.displayName.trim());
});

watch(
    () => props.modelValue,
    (newVal) => {
        if (!newVal) resetFile();
    }
);

function resetFile() {
    file.value = null;
    tableConfigs.value = [];
    if (fileInputRef.value) fileInputRef.value.value = '';
}

async function handleFileSelection(f: File) {
    file.value = f;
    const ext = f.name.split('.').pop()?.toLowerCase();

    if (ext === 'xlsx' || ext === 'xls') {
        try {
            const data = await f.arrayBuffer();
            const workbook = XLSX.read(data, { type: 'array' });
            tableConfigs.value = workbook.SheetNames.map((name) => ({
                sheetName: name,
                displayName: name, // Default to sheet name
                selected: true,
            }));
        } catch (err) {
            console.error('Failed to parse Excel sheets', err);
            // Fallback or error handled by parent/error prop
        }
    } else {
        // CSV
        tableConfigs.value = [
            {
                displayName: f.name.replace(/\.[^/.]+$/, ''),
                selected: true,
            },
        ];
    }
}

function handleChange(e: Event) {
    const files = (e.target as HTMLInputElement).files;
    if (files?.[0]) handleFileSelection(files[0]);
}

function handleDrop(e: DragEvent) {
    dragOver.value = false;
    const files = e.dataTransfer?.files;
    if (files?.[0]) handleFileSelection(files[0]);
}

function handleSubmit() {
    if (!file.value || !canSubmit.value) return;
    const finalConfigs = tableConfigs.value
        .filter((c) => c.selected)
        .map((c) => ({
            sheetName: c.sheetName,
            displayName: c.displayName.trim(),
        }));

    emit('submit', 0, file.value, finalConfigs);
}
</script>
