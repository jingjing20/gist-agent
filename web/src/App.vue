<template>
  <div class="app-layout">
    <ChatSidebar />
    <ChatDetail />
  </div>
</template>

<script setup lang="ts">
import ChatSidebar from './components/ChatSidebar.vue';
import ChatDetail from './components/ChatDetail.vue';
</script>

<style scoped>
.app-layout {
  display: flex;
  height: 100vh;
  overflow: hidden;
}
</style>
