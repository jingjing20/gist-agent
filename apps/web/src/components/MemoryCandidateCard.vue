<template>
    <article class="flex flex-col gap-3 rounded-xl border border-border p-4">
        <h4 class="font-medium">待保存记忆：{{ candidate.content.name }}</h4>
        <p class="text-sm text-muted-foreground">将写入数据源：{{ sourceName || '当前数据源' }}（{{ candidate.datasourceId }}）。保存后用于后续分析。</p>
        <MemoryEditor
            v-if="editing"
            :datasource-id="candidate.datasourceId"
            :content="candidate.content"
            :candidate-id="candidate.id"
            :candidate-version="candidate.version"
            :disabled="busy && !working"
            :memory-id="candidate.memoryId ?? undefined"
            :expected-version="candidate.expectedVersion ?? undefined"
            @saved="$emit('saved', $event)"
            @cancel="editing = false"
            @busy="working = $event"
        />
        <template v-else>
            <MemoryContent :content="candidate.content" />
            <p v-if="candidate.memoryId" class="text-sm text-muted-foreground">修改已有记忆 v{{ candidate.expectedVersion }}</p>
            <div class="flex flex-wrap gap-2">
                <Button :disabled="busy" @click="editing = true">编辑并保存</Button>
                <Button variant="outline" :disabled="busy" @click="$emit('reject')">放弃保存</Button>
                <slot />
            </div>
        </template>
    </article>
</template>
<script setup lang="ts">
import { ref, watch } from 'vue';
import type { MemoryCandidate } from '@gist/contracts';
import { Button } from '@/components/ui/button';
import MemoryContent from './MemoryContent.vue';
import MemoryEditor from './MemoryEditor.vue';
defineProps<{ candidate: MemoryCandidate; busy?: boolean; sourceName?: string }>();
const emit = defineEmits<{ saved: [result: { name: string; version: number }]; reject: []; busy: [value: boolean] }>();
const editing = ref(false),
    working = ref(false);
watch(working, (value) => emit('busy', value), { flush: 'sync' });
</script>
