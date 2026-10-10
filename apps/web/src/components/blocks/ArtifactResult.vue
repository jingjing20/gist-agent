<template>
    <section class="artifact-result">
        <component :is="renderer" v-bind="rendererProps">
            <template #actions>
                <div class="artifact-actions" aria-label="结果操作">
                    <Dialog v-model:open="evidenceOpen">
                        <DialogTrigger v-if="block.queryArtifactId && conversationId" as-child
                            ><Button variant="ghost" size="icon-sm" aria-label="查看依据" title="查看依据"><FileSearch data-icon="inline-start" /></Button
                        ></DialogTrigger>
                        <DialogContent class="sm:max-w-5xl max-h-[85dvh] flex flex-col" @close-auto-focus="restorePosition">
                            <DialogHeader
                                ><DialogTitle>分析依据 · {{ title }}</DialogTitle
                                ><DialogDescription>查询时的数据范围、口径与执行 SQL。</DialogDescription></DialogHeader
                            >
                            <div class="min-h-0 overflow-auto">
                                <QueryEvidence v-if="block.queryArtifactId && conversationId" :artifact-id="block.queryArtifactId" :conversation-id="conversationId" />
                            </div>
                        </DialogContent>
                    </Dialog>
                    <Dialog v-model:open="enlarged">
                        <DialogTrigger as-child
                            ><Button variant="ghost" size="icon-sm" aria-label="放大查看" title="放大查看"><Maximize2 data-icon="inline-start" /></Button
                        ></DialogTrigger>
                        <DialogContent class="sm:max-w-6xl max-h-[90dvh] flex flex-col" @close-auto-focus="restorePosition">
                            <DialogHeader
                                ><DialogTitle>{{ title }}</DialogTitle
                                ><DialogDescription class="sr-only">放大查看分析结果，关闭后返回原阅读位置。</DialogDescription></DialogHeader
                            >
                            <div class="enlarged-result min-h-0 overflow-auto">
                                <component :is="renderer" v-bind="rendererProps" />
                            </div>
                        </DialogContent>
                    </Dialog>
                </div>
            </template>
        </component>
    </section>
</template>
<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { FileSearch, Maximize2 } from '@lucide/vue';
import { Button } from '../ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogTrigger } from '../ui/dialog';
import ChartBlock from './ChartBlock.vue';
import TableBlock from './TableBlock.vue';
import AnalysisArtifactTable from './AnalysisArtifactTable.vue';
import QueryEvidence from './QueryEvidence.vue';
import type { MessageBlock } from '../../types';
const props = defineProps<{ block: MessageBlock; conversationId?: string }>();
const enlarged = ref(false),
    evidenceOpen = ref(false);
const title = computed(() => props.block.chartData?.title || props.block.title || '查询结果');
const renderer = computed(() => (props.block.type === 'chart' ? ChartBlock : props.block.queryArtifactId && props.conversationId ? AnalysisArtifactTable : TableBlock));
const rendererProps = computed(() =>
    props.block.type === 'chart'
        ? { chartData: props.block.chartData }
        : props.block.queryArtifactId && props.conversationId
          ? { artifactId: props.block.queryArtifactId, conversationId: props.conversationId, title: props.block.title }
          : { title: props.block.title, columns: props.block.columns, rows: props.block.rows, rowCount: props.block.rowCount, isLimited: props.block.isLimited }
);
let list: HTMLElement | null = null;
let scrollTop = 0;
watch(
    () => enlarged.value || evidenceOpen.value,
    (open) => {
        if (open) {
            list = document.querySelector('.message-list');
            scrollTop = list?.scrollTop || 0;
            list?.dispatchEvent(new CustomEvent('result-panel-open'));
        }
    }
);
function restorePosition() {
    if (list) {
        list.scrollTop = scrollTop;
        list.dispatchEvent(new CustomEvent('result-panel-close'));
    }
}
</script>
<style scoped>
.artifact-result {
    min-width: 0;
    display: flex;
    flex-direction: column;
}
.artifact-actions {
    display: flex;
    align-items: center;
    gap: 2px;
    opacity: 0;
    pointer-events: none;
    transition: opacity 150ms ease;
}
.enlarged-result :deep(.chart-container) {
    height: min(65dvh, 720px);
    min-height: 320px;
}
/* Keep controls in the result header without shifting the title or row count. */
.artifact-result:hover .artifact-actions,
.artifact-result:focus-within .artifact-actions {
    opacity: 1;
    pointer-events: auto;
}
@media (hover: none) {
    .artifact-actions {
        opacity: 1;
        pointer-events: auto;
    }
}
@media (prefers-reduced-motion: reduce) {
    .artifact-actions {
        transition: none;
    }
}
</style>
