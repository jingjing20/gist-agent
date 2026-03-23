<template>
  <ChatSidebar />
  <ChatDetail />
</template>

<script setup lang="ts">
import { onMounted, watch } from 'vue';
import { useRoute } from 'vue-router';
import ChatSidebar from '../components/ChatSidebar.vue';
import ChatDetail from '../components/ChatDetail.vue';
import { useChatStore } from '../stores/chat';

const route = useRoute();
const chatStore = useChatStore();

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
