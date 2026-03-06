<template>
  <div class="app-layout">
    <ChatSidebar />
    <ChatDetail />
  </div>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue';
import ChatSidebar from './components/ChatSidebar.vue';
import ChatDetail from './components/ChatDetail.vue';
import { useChatStore } from './stores/chat';

const store = useChatStore();

function handleHashChange() {
  const hash = window.location.hash.slice(2);
  if (hash && hash !== store.activeConversationId) {
    store.selectConversation(hash);
  } else if (!hash && store.activeConversationId) {
    store.startNewChat();
  }
}

onMounted(async () => {
  await store.fetchConversations();
  const hash = window.location.hash.slice(2);
  if (hash) {
    store.selectConversation(hash);
  }
  window.addEventListener('hashchange', handleHashChange);
});

onUnmounted(() => {
  window.removeEventListener('hashchange', handleHashChange);
});
</script>

<style scoped>
.app-layout {
  display: flex;
  height: 100vh;
  overflow: hidden;
}
</style>
