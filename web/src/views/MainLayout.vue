<template>
  <div class="app-root">
    <header class="app-header">
      <div class="header-brand">
        <div class="logo-icon">
          <i class="fas fa-chart-line"></i>
        </div>
        <span class="brand-text">Gist Agent</span>
      </div>

      <nav class="header-tabs">
        <button
          class="tab-btn"
          :class="{ active: activeTab === 'chat' }"
          @click="router.push('/chat')"
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
        <div class="user-dropdown" ref="dropdownRef" @click="toggleDropdown">
          <img
            class="user-avatar"
            src="https://api.dicebear.com/7.x/notionists/svg?seed=GistAgent"
            alt="avatar"
          />
          <span class="user-name">{{
            authStore.user?.name || authStore.user?.email
          }}</span>

          <div v-show="showDropdown" class="dropdown-menu">
            <div class="dropdown-item" @click="openProfileModal">个人信息</div>
            <div class="dropdown-item" @click="openPasswordModal">修改密码</div>
            <a
              href="https://github.com/jingjing20/gist-agent"
              target="_blank"
              class="dropdown-item link-item"
              >github 地址</a
            >
            <div class="dropdown-divider"></div>
            <div class="dropdown-item text-danger" @click="handleLogout">
              退出登录
            </div>
          </div>
        </div>
      </div>
    </header>
    <div class="app-body">
      <router-view />
    </div>

    <!-- 个人信息弹框 -->
    <div
      v-if="profileModalVisible"
      class="modal-overlay"
      @click.self="profileModalVisible = false"
    >
      <div class="modal-content">
        <h3>个人信息</h3>
        <div class="form-item">
          <label>邮箱</label>
          <input
            type="text"
            :value="authStore.user?.email"
            disabled
            class="disabled-input"
          />
        </div>
        <div class="form-item">
          <label>用户名</label>
          <input type="text" v-model="profileForm.name" />
        </div>
        <div class="modal-actions">
          <button class="btn-cancel" @click="profileModalVisible = false">
            取消
          </button>
          <button class="btn-primary" @click="submitProfile">保存</button>
        </div>
      </div>
    </div>

    <!-- 修改密码弹框 -->
    <div
      v-if="passwordModalVisible"
      class="modal-overlay"
      @click.self="passwordModalVisible = false"
    >
      <div class="modal-content">
        <h3>修改密码</h3>
        <div class="form-item">
          <label>新密码</label>
          <input
            type="password"
            v-model="passwordForm.password"
            placeholder="请输入新密码"
          />
        </div>
        <div class="form-item">
          <label>确认新密码</label>
          <input
            type="password"
            v-model="passwordForm.confirmPassword"
            placeholder="请确认新密码"
          />
        </div>
        <div class="modal-actions">
          <button class="btn-cancel" @click="passwordModalVisible = false">
            取消
          </button>
          <button class="btn-primary" @click="submitPassword">提交</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, reactive, onMounted, onUnmounted } from "vue";
import { useRouter, useRoute } from "vue-router";
import { useDataSourceStore } from "../stores/datasource";
import { useAuthStore } from "../stores/auth";
import { useToastStore } from "../stores/toast";

const router = useRouter();
const route = useRoute();
const dsStore = useDataSourceStore();
const authStore = useAuthStore();
const toast = useToastStore();

const activeTab = computed<"chat" | "datasource">(() =>
  route.name === "datasource" ? "datasource" : "chat",
);

function goToDataSource() {
  router.push("/datasource");
  dsStore.fetchAll();
}

const showDropdown = ref(false);
const dropdownRef = ref<HTMLElement | null>(null);

const profileModalVisible = ref(false);
const passwordModalVisible = ref(false);

function toggleDropdown() {
  showDropdown.value = !showDropdown.value;
}

function handleClickOutside(event: MouseEvent) {
  if (dropdownRef.value && !dropdownRef.value.contains(event.target as Node)) {
    showDropdown.value = false;
  }
}

onMounted(() => {
  document.addEventListener("click", handleClickOutside);
});

onUnmounted(() => {
  document.removeEventListener("click", handleClickOutside);
});

const profileForm = reactive({ name: "" });
const passwordForm = reactive({ password: "", confirmPassword: "" });

function openProfileModal() {
  showDropdown.value = false;
  profileForm.name = authStore.user?.name || "";
  profileModalVisible.value = true;
}

function openPasswordModal() {
  showDropdown.value = false;
  passwordForm.password = "";
  passwordForm.confirmPassword = "";
  passwordModalVisible.value = true;
}

async function submitProfile() {
  if (!profileForm.name.trim()) return toast.error("用户名不能为空");
  try {
    await authStore.updateProfile(profileForm.name);
    toast.success("个人信息已更新");
    profileModalVisible.value = false;
  } catch (err: any) {
    toast.error(err.message || "更新失败");
  }
}

async function submitPassword() {
  if (!passwordForm.password || passwordForm.password.length < 6) {
    return toast.error("密码至少需要 6 个字符");
  }
  if (passwordForm.password !== passwordForm.confirmPassword) {
    return toast.error("两次输入的密码不一致");
  }
  try {
    await authStore.updatePassword(passwordForm.password);
    toast.success("密码修改成功");
    passwordModalVisible.value = false;
  } catch (err: any) {
    toast.error(err.message || "修改密码失败");
  }
}

function handleLogout() {
  showDropdown.value = false;
  authStore.logout();
  toast.info("已退出登录");
  router.push("/login");
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
  width: 32px;
  height: 32px;
  background: linear-gradient(135deg, var(--da-primary), #8b5cf6);
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 15px;
  color: #fff;
  box-shadow: 0 4px 12px rgba(14, 165, 233, 0.2);
}

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
  position: relative;
  height: 100%;
  padding: 0 20px;
  color: var(--da-text-muted);
  font-size: 15px;
  font-weight: 500;
  background: transparent;
  border: none;
  cursor: pointer;
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  font-family: inherit;
}

.tab-btn:hover {
  color: var(--da-text-main);
}

.tab-btn.active {
  color: #fff;
  font-weight: 600;
}

.tab-btn::after {
  content: "";
  position: absolute;
  bottom: 0;
  left: 20px;
  right: 20px;
  height: 3px;
  background: var(--da-primary);
  border-radius: 3px 3px 0 0;
  transform: scaleX(0);
  transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  box-shadow: 0 -2px 10px var(--da-primary);
}

.tab-btn.active::after {
  transform: scaleX(1);
}

.header-user {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 16px;
  width: 256px;
}

.user-dropdown {
  position: relative;
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  padding: 10px 0;
}

.user-name {
  font-size: 14px;
  font-weight: 500;
  color: var(--da-text-main);
}

.user-avatar {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  border: 1px solid var(--da-border);
  background: #fff;
}

.dropdown-menu {
  position: absolute;
  top: 100%;
  right: 0;
  width: 160px;
  background: var(--da-panel);
  border: 1px solid var(--da-border);
  border-radius: 8px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  padding: 8px 0;
  z-index: 100;
  margin-top: -4px;
}

.dropdown-item {
  padding: 8px 16px;
  font-size: 14px;
  color: var(--da-text-main);
  cursor: pointer;
  transition: all 0.2s;
  display: block;
}

.dropdown-item:hover {
  background: rgba(255, 255, 255, 0.05);
}

.link-item {
  text-decoration: none;
}

.text-danger {
  color: #ef4444;
}

.dropdown-divider {
  height: 1px;
  background: var(--da-border);
  margin: 4px 0;
}

.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 999;
}

.modal-content {
  background: var(--da-panel);
  border: 1px solid var(--da-border);
  border-radius: 12px;
  padding: 24px;
  width: 400px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.2);
}

.modal-content h3 {
  margin: 0 0 20px 0;
  font-size: 18px;
  font-weight: 600;
}

.form-item {
  margin-bottom: 16px;
}

.form-item label {
  display: block;
  margin-bottom: 8px;
  font-size: 14px;
  color: var(--da-text-muted);
}

.form-item input {
  width: 100%;
  padding: 8px 12px;
  background: var(--da-bg);
  border: 1px solid var(--da-border);
  border-radius: 6px;
  color: var(--da-text-main);
  outline: none;
  font-size: 14px;
}

.form-item input:focus {
  border-color: var(--da-primary);
}

.form-item input.disabled-input {
  opacity: 0.6;
  cursor: not-allowed;
}

.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 12px;
  margin-top: 24px;
}

.btn-cancel,
.btn-primary {
  padding: 8px 16px;
  border-radius: 6px;
  font-size: 14px;
  cursor: pointer;
  border: none;
}

.btn-cancel {
  background: rgba(255, 255, 255, 0.1);
  color: #fff;
}

.btn-cancel:hover {
  background: rgba(255, 255, 255, 0.2);
}

.btn-primary {
  background: var(--da-primary);
  color: #fff;
}

.btn-primary:hover {
  opacity: 0.9;
}

.app-body {
  flex: 1;
  display: flex;
  overflow: hidden;
}
</style>
