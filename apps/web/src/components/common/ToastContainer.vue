<template>
    <Teleport to="body">
        <div class="toast-container">
            <ToastItem v-for="toast in toastStore.toasts" :key="toast.id" :type="toast.type" :message="toast.message" @close="toastStore.remove(toast.id)" />
        </div>
    </Teleport>
</template>

<script setup lang="ts">
import { useToastStore } from '../../stores/toast';
import ToastItem from './ToastItem.vue';

const toastStore = useToastStore();
</script>

<style scoped>
.toast-container {
    position: fixed;
    top: 24px;
    right: 24px;
    z-index: 10000;
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    pointer-events: none;
}
</style>
