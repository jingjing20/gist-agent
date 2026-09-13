<template>
    <Transition name="toast-fade">
        <div class="toast-item" :class="['toast-' + type]" role="alert">
            <div class="toast-icon">
                <i v-if="type === 'success'" class="fas fa-check-circle"></i>
                <i v-else-if="type === 'error'" class="fas fa-exclamation-circle"></i>
                <i v-else-if="type === 'warning'" class="fas fa-exclamation-triangle"></i>
                <i v-else class="fas fa-info-circle"></i>
            </div>
            <div class="toast-content">
                {{ message }}
            </div>
            <button class="toast-close" @click="$emit('close')">
                <i class="fas fa-times"></i>
            </button>
        </div>
    </Transition>
</template>

<script setup lang="ts">
import type { ToastType } from '../../stores/toast';

defineProps<{
    type: ToastType;
    message: string;
}>();

defineEmits(['close']);
</script>

<style scoped>
.toast-item {
    display: flex;
    align-items: center;
    gap: 12px;
    min-width: 300px;
    max-width: 450px;
    padding: 16px 20px;
    border-radius: 12px;
    background: rgba(30, 41, 59, 0.85);
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
    border: 1px solid rgba(255, 255, 255, 0.1);
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
    color: #fff;
    margin-bottom: 12px;
    pointer-events: auto;
    position: relative;
    overflow: hidden;
}

.toast-item::before {
    content: '';
    position: absolute;
    left: 0;
    top: 0;
    bottom: 0;
    width: 4px;
}

.toast-success::before {
    background: #10b981;
}
.toast-error::before {
    background: #ef4444;
}
.toast-warning::before {
    background: #f59e0b;
}
.toast-info::before {
    background: #3b82f6;
}

.toast-icon {
    font-size: 18px;
    flex-shrink: 0;
}

.toast-success .toast-icon {
    color: #10b981;
}
.toast-error .toast-icon {
    color: #ef4444;
}
.toast-warning .toast-icon {
    color: #f59e0b;
}
.toast-info .toast-icon {
    color: #3b82f6;
}

.toast-content {
    flex: 1;
    font-size: 14px;
    font-weight: 500;
    line-height: 1.5;
}

.toast-close {
    background: none;
    border: none;
    color: rgba(255, 255, 255, 0.4);
    cursor: pointer;
    font-size: 14px;
    padding: 4px;
    transition: color 0.2s;
    display: flex;
    align-items: center;
    justify-content: center;
}

.toast-close:hover {
    color: #fff;
}

/* Animations */
.toast-fade-enter-active,
.toast-fade-leave-active {
    transition: all 0.4s cubic-bezier(0.16, 1, 0.3, 1);
}

.toast-fade-enter-from {
    opacity: 0;
    transform: translateX(40px) scale(0.9);
}

.toast-fade-leave-to {
    opacity: 0;
    transform: translateX(20px) scale(0.95);
}
</style>
