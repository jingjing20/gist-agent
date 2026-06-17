<template>
    <div class="auth-block">
        <div class="auth-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
            </svg>
        </div>
        <div class="auth-content">
            <h4 class="title">数据表访问受限</h4>
            <p class="desc">本次分析需要读取以下由于未授权而拦截的数据库表：</p>
            <ul class="tables-list">
                <li v-for="t in tables" :key="t">
                    <code>{{ t }}</code>
                </li>
            </ul>
            <div v-if="reason" class="reason"><strong>需要权限原因：</strong>{{ reason }}</div>
            <button class="apply-btn" @click="handleApply" :disabled="applied">
                {{ applied ? '申请已提交并等待审批' : '立即申请表权限' }}
            </button>
        </div>
    </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { useToastStore } from '../../stores/toast';

defineProps<{
    tables?: string[];
    reason?: string;
}>();

const applied = ref(false);
const toast = useToastStore();

function handleApply() {
    applied.value = true;
    toast.info('申请已提交，请等待管理员审批');
}
</script>

<style scoped>
.auth-block {
    display: flex;
    gap: 16px;
    background: var(--bg-code);
    border: 1px solid rgba(239, 68, 68, 0.3);
    padding: 16px;
    border-radius: 8px;
    margin: 12px 0;
}

.auth-icon {
    width: 24px;
    height: 24px;
    color: #ef4444;
    flex-shrink: 0;
}

.title {
    margin: 0 0 8px;
    font-size: 15px;
    color: #ef4444;
}

.desc {
    margin: 0 0 8px;
    font-size: 13px;
    color: var(--text-secondary);
}

.tables-list {
    margin: 0 0 12px;
    padding-left: 20px;
    font-size: 13px;
    color: var(--text-primary);
}

.tables-list code {
    background: var(--bg-primary);
    padding: 2px 6px;
    border-radius: 4px;
}

.reason {
    background: var(--bg-primary);
    padding: 8px 12px;
    border-radius: 6px;
    font-size: 13px;
    color: var(--text-secondary);
    border-left: 3px solid var(--da-primary);
    margin-bottom: 16px;
}

.apply-btn {
    background: var(--da-primary);
    color: white;
    border: none;
    padding: 8px 16px;
    border-radius: 6px;
    font-size: 13px;
    cursor: pointer;
    transition: opacity 0.2s;
}

.apply-btn:hover:not(:disabled) {
    background: var(--da-primary-hover);
}

.apply-btn:disabled {
    background: var(--bg-hover);
    color: var(--text-secondary);
    cursor: not-allowed;
}
</style>
