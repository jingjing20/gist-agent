<template>
    <Teleport to="body">
        <div v-if="modelValue" class="modal-overlay">
            <div class="modal da-modal">
                <button class="modal-close" @click="emit('update:modelValue', null)">
                    <i class="fas fa-times"></i>
                </button>
                <h3>编辑数据源</h3>
                <div class="da-form">
                    <div class="form-group">
                        <label>数据源名称</label>
                        <input v-model="form.name" placeholder="请输入数据源名称" />
                    </div>
                    <div class="form-group">
                        <label>描 述</label>
                        <textarea v-model="form.description" placeholder="请输入数据源描述（可选）" rows="3"></textarea>
                    </div>
                    <div v-if="error" class="da-error-msg">{{ error }}</div>
                </div>
                <div class="modal-footer">
                    <button class="btn-da-ghost" @click="emit('update:modelValue', null)">取消</button>
                    <button class="btn-da-primary" :disabled="!form.name || submitting" @click="handleSubmit">
                        {{ submitting ? '保存中...' : '保存修改' }}
                    </button>
                </div>
            </div>
        </div>
    </Teleport>
</template>

<script setup lang="ts">
import { reactive, watch } from 'vue';
import type { DataSource } from '../../stores/datasource';

const props = defineProps<{
    modelValue: DataSource | null;
    submitting: boolean;
    error?: string;
}>();

const emit = defineEmits<{
    (e: 'update:modelValue', value: DataSource | null): void;
    (e: 'submit', form: { name: string; description: string }): void;
}>();

const form = reactive({
    name: '',
    description: '',
});

watch(
    () => props.modelValue,
    (newVal) => {
        if (newVal) {
            form.name = newVal.name;
            form.description = newVal.description || '';
        }
    },
    { immediate: true }
);

function handleSubmit() {
    if (form.name) {
        emit('submit', { ...form });
    }
}
</script>

<style scoped>
/* modal-overlay is now global in style.css */

.modal {
    background: var(--da-panel);
    border: 1px solid var(--da-border);
    border-radius: 20px;
    padding: 32px;
    width: 460px;
    box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5);
    animation: modal-pop 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
}

@keyframes modal-pop {
    from {
        opacity: 0;
        transform: scale(0.95);
    }
    to {
        opacity: 1;
        transform: scale(1);
    }
}

.modal h3 {
    font-size: 20px;
    font-weight: 700;
    color: #fff;
    margin-bottom: 24px;
    margin-top: 0;
}

.form-group {
    margin-bottom: 20px;
}

.form-group label {
    display: block;
    font-size: 13px;
    font-weight: 600;
    color: var(--da-text-muted);
    margin-bottom: 8px;
}

.form-group input,
.form-group textarea {
    width: 100%;
    background: var(--da-card);
    border: 1px solid var(--da-border);
    border-radius: 10px;
    padding: 10px 14px;
    color: #fff;
    font-size: 14px;
    outline: none;
    transition: all 0.2s;
    font-family: inherit;
    resize: none;
}

.form-group input:focus,
.form-group textarea:focus {
    border-color: var(--da-primary);
    background: rgba(14, 165, 233, 0.05);
}

.da-error-msg {
    color: #ef4444;
    font-size: 12px;
    margin-top: 12px;
}

.modal-footer {
    display: flex;
    justify-content: flex-end;
    gap: 12px;
    margin-top: 32px;
}

.btn-da-primary {
    background: var(--da-primary);
    color: #fff;
    border: none;
    padding: 10px 24px;
    border-radius: 10px;
    font-weight: 600;
    cursor: pointer;
}

.btn-da-primary:disabled {
    opacity: 0.5;
    cursor: not-allowed;
}

.btn-da-ghost {
    background: var(--da-card);
    color: var(--da-text-main);
    border: 1px solid var(--da-border);
    padding: 10px 24px;
    border-radius: 10px;
    font-weight: 600;
    cursor: pointer;
}
</style>
