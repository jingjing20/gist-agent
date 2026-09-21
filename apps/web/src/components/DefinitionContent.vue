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
import type { BusinessDefinitionContent } from '@gist/contracts';
const props = defineProps<{ content: BusinessDefinitionContent }>();
const fields = computed(() => {
    const c = props.content;
    const labels: Record<string, string> = {
        numerator: '分子',
        denominator: '分母',
        entityGrain: '实体粒度',
        timeWindow: '时间窗口',
        timezone: '时区',
        unit: '单位',
        conditions: '适用条件',
    };
    const cardinality = { 'one-to-one': '一对一', 'one-to-many': '一对多', 'many-to-one': '多对一', 'many-to-many': '多对多' };
    return {
        类型: { metric: '指标', term: '术语', relationship: '关系' }[c.type],
        名称: c.name,
        业务含义: c.description,
        别名: c.aliases?.join('、') || '无',
        关联字段: c.relatedFields?.join('、') || '无',
        ...Object.fromEntries(Object.entries(c.metric || {}).map(([k, v]) => [labels[k] || k, v])),
        ...(c.relationship
            ? { 左侧字段: c.relationship.leftField, 右侧字段: c.relationship.rightField, 预期基数: cardinality[c.relationship.cardinality], 关系说明: c.relationship.explanation }
            : {}),
    };
});
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
