<template>
    <dl>
        <template v-for="(value, label) in fields" :key="label"
            ><dt>{{ label }}</dt>
            <dd>{{ value }}</dd></template
        >
    </dl>
</template>
<script setup lang="ts">
import { computed } from 'vue';
import type { MemoryContent } from '@gist/contracts';
const props = defineProps<{ content: MemoryContent }>();
const fields = computed(() => ({ 标题: props.content.name, 内容: props.content.description }));
</script>
<style scoped>
dl {
    display: grid;
    grid-template-columns: 100px minmax(0, 1fr);
    gap: 8px;
}
dt {
    color: var(--da-text-muted);
}
dd {
    margin: 0;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
}
</style>
