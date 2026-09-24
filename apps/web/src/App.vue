<template>
    <router-view />
    <Button v-if="route.meta.public" class="auth-theme-toggle" variant="outline" size="icon" :aria-label="mode === 'dark' ? '切换到浅色主题' : '切换到深色主题'" @click="mode = mode === 'dark' ? 'light' : 'dark'">
        <Sun v-if="mode === 'dark'" /><Moon v-else />
    </Button>
    <ToastContainer />
</template>

<script setup lang="ts">
import { useColorMode } from '@vueuse/core';
import { useRoute } from 'vue-router';
import { Moon, Sun } from '@lucide/vue';
import { Button } from '@/components/ui/button';
import ToastContainer from './components/common/ToastContainer.vue';

const route = useRoute();
const mode = useColorMode({ initialValue: 'dark' });
</script>
