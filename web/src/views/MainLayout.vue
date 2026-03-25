<template>
  <div class="app-root">
    <header class="app-header">
      <div class="header-brand">
        <div class="logo-icon">
          <div class="logo-bar logo-bar-1"></div>
          <div class="logo-bar logo-bar-2"></div>
          <div class="logo-bar logo-bar-3"></div>
        </div>
        <span class="brand-text">DataAgent</span>
      </div>

      <nav class="header-tabs">
        <button
          class="tab-btn"
          :class="{ active: activeTab === 'chat' }"
          @click="router.push('/')"
        >
          开始分析
        </button>
        <button
          class="tab-btn"
          :class="{ active: activeTab === 'datasource' }"
          @click="goToDataSource"
        >
          数据源
        </button>
      </nav>

      <div class="header-user">
        <div class="user-info">
          <img class="user-avatar" src="https://api.dicebear.com/7.x/notionists/svg?seed=DataAgent" alt="avatar" />
          <span class="user-name">{{ authStore.user?.name || authStore.user?.email }}</span>
        </div>
        <button class="btn-logout" @click="handleLogout">退出</button>
      </div>
    </header>
    <div class="app-body">
      <router-view />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { useDataSourceStore } from '../stores/datasource';
import { useAuthStore } from '../stores/auth';

const router = useRouter();
const route = useRoute();
const dsStore = useDataSourceStore();
const authStore = useAuthStore();

const activeTab = computed<'chat' | 'datasource'>(() =>
  route.name === 'datasource' ? 'datasource' : 'chat',
);

function goToDataSource() {
  router.push('/datasource');
  dsStore.fetchAll();
}

function handleLogout() {
  authStore.logout();
  router.push('/login');
}
</script>

<style scoped>
.app-root {
  display: flex;
  flex-direction: column;
  height: 100vh;
  width: 100vw;
  overflow: hidden;
  background: var(--da-bg);
  color: var(--da-text-main);
}

.app-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 24px;
  height: 60px;
  border-bottom: 1px solid var(--da-border);
  background: rgba(30, 35, 48, 0.5); /* da-panel with alpha */
  flex-shrink: 0;
}

.header-brand {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 256px;
}

.logo-icon {
  display: flex;
  align-items: flex-end;
  gap: 2px;
}

.logo-bar {
  width: 6px;
  border-radius: 2px 2px 0 0;
}

.logo-bar-1 { height: 16px; background: var(--da-gradient-start); }
.logo-bar-2 { height: 24px; background: var(--da-primary); }
.logo-bar-3 { height: 12px; background: var(--da-gradient-end); }

.brand-text {
  font-size: 20px;
  font-weight: 600;
  letter-spacing: 0.025em;
  color: #fff;
}

.header-tabs {
  display: flex;
  align-items: center;
  height: 100%;
  gap: 32px;
}

.tab-btn {
  height: 100%;
  padding: 0 16px;
  color: var(--da-text-muted);
  font-size: 15px;
  font-weight: 500;
  background: transparent;
  border: none;
  cursor: pointer;
  border-bottom: 2px solid transparent;
  transition: color 0.2s;
  font-family: inherit;
}

.tab-btn:hover {
  color: #fff;
}

.tab-btn.active {
  color: #fff;
  border-bottom-color: var(--da-primary);
}

.header-user {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 16px;
  width: 256px;
}

.user-info {
  display: flex;
  align-items: center;
  gap: 8px;
}

.user-avatar {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  border: 1px solid var(--da-border);
  background: #fff;
}

.user-name {
  font-size: 14px;
  font-weight: 500;
  color: var(--da-text-main);
}

.btn-logout {
  padding: 6px 16px;
  font-size: 14px;
  background: var(--da-card);
  color: var(--da-text-main);
  border: 1px solid var(--da-border);
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.2s;
  font-family: inherit;
}

.btn-logout:hover {
  background: var(--da-border);
}

.app-body {
  flex: 1;
  display: flex;
  overflow: hidden;
}
</style>
