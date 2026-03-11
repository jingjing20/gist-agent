<template>
  <div class="app-root">
    <header class="app-header">
      <div class="header-brand">DataAgent</div>
      <nav class="header-tabs">
        <button
          class="tab-btn"
          :class="{ active: activeTab === 'chat' }"
          @click="goToChat"
        >
          数据分析
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
        <span class="user-name">{{ authStore.user?.name || authStore.user?.email }}</span>
        <button class="btn-logout" @click="handleLogout">退出</button>
      </div>
    </header>

    <div class="app-body">
      <template v-if="activeTab === 'chat'">
        <ChatSidebar />
        <ChatDetail />
      </template>
      <template v-else>
        <DataSourcePage />
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, watch } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import ChatSidebar from '../components/ChatSidebar.vue';
import ChatDetail from '../components/ChatDetail.vue';
import DataSourcePage from '../components/DataSourcePage.vue';
import { useChatStore } from '../stores/chat';
import { useDataSourceStore } from '../stores/datasource';
import { useAuthStore } from '../stores/auth';

const router = useRouter();
const route = useRoute();
const chatStore = useChatStore();
const dsStore = useDataSourceStore();
const authStore = useAuthStore();

const activeTab = computed<'chat' | 'datasource'>(() =>
  route.path === '/datasource' ? 'datasource' : 'chat',
);

function goToChat() {
  router.push('/');
}

function goToDataSource() {
  router.push('/datasource');
  dsStore.fetchAll();
}

function handleLogout() {
  authStore.logout();
  router.push('/login');
}

function syncRouteToConversation() {
  if (route.path === '/datasource') return;
  const convId = route.params.convId as string | undefined;
  if (convId && convId !== 'login' && convId !== 'register') {
    chatStore.selectConversation(convId);
  } else if (!convId && chatStore.activeConversationId) {
    chatStore.startNewChat();
  }
}

watch(() => [route.path, route.params.convId], syncRouteToConversation);

onMounted(async () => {
  await chatStore.fetchConversations();
  syncRouteToConversation();
});
</script>

<style scoped>
.app-root {
  display: flex;
  flex-direction: column;
  height: 100vh;
  overflow: hidden;
}

.app-header {
  display: flex;
  align-items: center;
  gap: 32px;
  padding: 0 24px;
  height: 52px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-sidebar);
  flex-shrink: 0;
}

.header-brand {
  font-size: 15px;
  font-weight: 700;
  color: var(--text-primary);
  letter-spacing: -0.02em;
}

.header-tabs {
  display: flex;
  gap: 4px;
}

.tab-btn {
  background: none;
  border: none;
  color: var(--text-secondary);
  font-size: 13px;
  font-weight: 500;
  padding: 6px 14px;
  border-radius: 7px;
  cursor: pointer;
  transition: all 0.15s;
  font-family: inherit;
}

.tab-btn:hover {
  color: var(--text-primary);
  background: var(--bg-hover);
}

.tab-btn.active {
  color: var(--text-primary);
  background: var(--bg-active);
}

.header-user {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 12px;
}

.user-name {
  font-size: 12px;
  color: var(--text-secondary);
}

.btn-logout {
  background: none;
  border: 1px solid var(--border);
  color: var(--text-secondary);
  font-size: 12px;
  padding: 4px 10px;
  border-radius: 6px;
  cursor: pointer;
  font-family: inherit;
}

.btn-logout:hover {
  color: var(--text-primary);
  border-color: var(--text-secondary);
}

.app-body {
  flex: 1;
  display: flex;
  overflow: hidden;
}
</style>
