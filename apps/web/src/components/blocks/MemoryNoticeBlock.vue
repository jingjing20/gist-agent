<template>
    <section v-if="notice" class="flex flex-col gap-2 rounded-lg border border-border p-4 text-sm" aria-label="记忆保存结果">
        <p role="status">{{ notice.message }}</p>
        <details v-if="notice.memory">
            <summary>{{ notice.memory.name }} · v{{ notice.memory.version }}（保存时版本）</summary>
            <MemoryContent :content="notice.memory" />
        </details>
        <RouterLink
            class="text-primary underline"
            :to="{ path: '/memories', query: { datasourceId: notice.datasourceId, ...(notice.memory ? { memoryId: notice.memory.id } : {}) } }"
            >查看、编辑或删除记忆</RouterLink
        >
    </section>
</template>
<script setup lang="ts">
import type { MemoryNotice } from '@gist/contracts';
import MemoryContent from '../MemoryContent.vue';
defineProps<{ notice?: MemoryNotice }>();
</script>
