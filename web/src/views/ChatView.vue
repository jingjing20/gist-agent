<template>
  <div class="chat-view-container">
    <ChatSidebar
      :collapsed="isSidebarCollapsed"
      @collapse="isSidebarCollapsed = true"
    />
    <ChatDetail
      @toggle-drawer="isDrawerOpen = !isDrawerOpen"
      @open-sidebar="isSidebarCollapsed = false"
      :sidebar-collapsed="isSidebarCollapsed"
      :drawer-open="isDrawerOpen"
    />
    <DataSourceDrawer v-model="isDrawerOpen" />
  </div>
</template>

<script setup lang="ts">
import { onMounted, watch, ref } from "vue";
import { useRoute } from "vue-router";
import ChatSidebar from "../components/ChatSidebar.vue";
import ChatDetail from "../components/ChatDetail.vue";
import DataSourceDrawer from "../components/DataSourceDrawer.vue";
import { useChatStore } from "../stores/chat";

const route = useRoute();
const chatStore = useChatStore();
const isDrawerOpen = ref(false);
const isSidebarCollapsed = ref(false);

function syncConversation() {
  const convId = route.params.convId as string | undefined;
  if (convId) {
    if (chatStore.activeConversationId !== convId) {
      chatStore.selectConversation(convId);
    }
  } else {
    chatStore.startNewChat();
  }
}

watch(() => route.params.convId, syncConversation);

onMounted(async () => {
  await chatStore.fetchConversations();
  syncConversation();
});
</script>

<style scoped>
.chat-view-container {
  display: flex;
  width: 100%;
  height: 100%;
  overflow: hidden;
}
</style>
