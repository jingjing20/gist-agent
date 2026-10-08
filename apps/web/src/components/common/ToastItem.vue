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
    background: color-mix(in srgb, var(--da-panel) 85%, transparent);
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
    border: 1px solid color-mix(in srgb, var(--foreground) 10%, transparent);
    box-shadow: 0 8px 32px color-mix(in srgb, var(--shadow-color) 30%, transparent);
    color: var(--da-text-main);
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
    background: var(--status-success);
}
.toast-error::before {
    background: var(--destructive);
}
.toast-warning::before {
    background: var(--status-warning);
}
.toast-info::before {
    background: var(--da-gradient-end);
}

.toast-icon {
    font-size: 18px;
    flex-shrink: 0;
}

.toast-success .toast-icon {
    color: var(--status-success);
}
.toast-error .toast-icon {
    color: var(--destructive);
}
.toast-warning .toast-icon {
    color: var(--status-warning);
}
.toast-info .toast-icon {
    color: var(--da-gradient-end);
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
    color: color-mix(in srgb, var(--foreground) 40%, transparent);
    cursor: pointer;
    font-size: 14px;
    padding: 4px;
    transition: color 0.2s;
    display: flex;
    align-items: center;
    justify-content: center;
}

.toast-close:hover {
    color: var(--da-text-main);
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
