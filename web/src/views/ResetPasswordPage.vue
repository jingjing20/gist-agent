<template>
  <div class="auth-page">
    <div class="glass-card">
      <!-- Left: Branding -->
      <div class="branding">
        <div class="branding-content">
          <h1 class="logo-text">Gist Agent</h1>
          <h2 class="hero-title">设置新密码，<br />重返工作台</h2>
          <p class="hero-desc">
            请为您的账号设置一个新的强密码。建议包含字母、数字和特殊字符以增强安全性。
          </p>
        </div>
      </div>

      <!-- Right: Form -->
      <div class="form-panel">
        <div class="form-container">
          <div class="form-header">
            <div class="logo-box">
              <div class="logo-icon">
                <i class="fas fa-lock"></i>
              </div>
              <span class="logo-name">Gist Agent</span>
            </div>
            <h3>设置新密码</h3>
            <p>请输入您的新密码并确认</p>
          </div>

          <form @submit.prevent="handleSubmit" class="auth-form">
            <div class="input-group">
              <div class="input-wrapper">
                <i class="fas fa-lock"></i>
                <input
                  v-model="password"
                  type="password"
                  placeholder="输入新密码"
                  required
                />
              </div>
            </div>

            <div class="input-group">
              <div class="input-wrapper">
                <i class="fas fa-check-circle"></i>
                <input
                  v-model="confirmPassword"
                  type="password"
                  placeholder="再次输入确认"
                  required
                />
              </div>
            </div>

            <div v-if="error" class="form-error">
              <i class="fas fa-exclamation-circle"></i>
              {{ error }}
            </div>

            <button type="submit" class="btn-primary" :disabled="loading">
              <span v-if="!loading">确认修改密码</span>
              <span v-else class="loading-spinner"
                ><i class="fas fa-spinner fa-spin"></i> 处理中...</span
              >
            </button>
          </form>

          <div class="form-footer">
            不打算改了？<router-link to="/login">返回登录</router-link>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { apiFetch } from "../api";
import { useToastStore } from "../stores/toast";

const route = useRoute();
const router = useRouter();
const toast = useToastStore();
const password = ref("");
const confirmPassword = ref("");
const loading = ref(false);
const error = ref("");

async function handleSubmit() {
  if (password.value !== confirmPassword.value) {
    error.value = "两次输入的密码不一致";
    return;
  }
  const token = route.query.token as string;
  if (!token) {
    error.value = "无效的重置链接";
    return;
  }
  loading.value = true;
  error.value = "";
  try {
    const res = await apiFetch("/auth/reset-password", {
      method: "POST",
      body: JSON.stringify({ token, password: password.value }),
    });
    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.message || "重置失败");
    }
    toast.success("密码重置成功，请登录");
    router.replace("/login");
  } catch (e: any) {
    error.value = e.message;
    toast.error("重置密码失败: " + error.value);
  } finally {
    loading.value = false;
  }
}
</script>

<style scoped>
.auth-page {
  min-height: 100vh;
  width: 100vw;
  display: flex;
  align-items: center;
  justify-content: center;
  background-image: url("../assets/images/auth_bg.png");
  background-size: cover;
  background-position: center;
  overflow: hidden;
  padding: 40px;
}

.glass-card {
  display: flex;
  width: 100%;
  max-width: 1100px;
  min-height: 580px;
  background: rgba(15, 17, 26, 0.4);
  backdrop-filter: blur(40px);
  -webkit-backdrop-filter: blur(40px);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 40px;
  overflow: hidden;
  box-shadow: 0 40px 100px rgba(0, 0, 0, 0.6);
}

.branding {
  flex: 1.2;
  padding: 80px;
  display: flex;
  align-items: center;
  position: relative;
}

.branding::after {
  content: "";
  position: absolute;
  top: 10%;
  right: 0;
  bottom: 10%;
  width: 1px;
  background: linear-gradient(
    to bottom,
    transparent,
    rgba(255, 255, 255, 0.1),
    transparent
  );
}

.branding-content {
  max-width: 480px;
}

.logo-text {
  font-size: 32px;
  font-weight: 800;
  color: #fff;
  margin-bottom: 60px;
  letter-spacing: -0.02em;
}

.hero-title {
  font-size: 48px;
  font-weight: 800;
  color: #fff;
  line-height: 1.2;
  margin-bottom: 32px;
  letter-spacing: -0.01em;
}

.hero-desc {
  font-size: 16px;
  color: rgba(255, 255, 255, 0.6);
  line-height: 1.6;
}

.form-panel {
  flex: 0 0 440px;
  background: rgba(0, 0, 0, 0.15);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 60px;
}

.form-container {
  width: 100%;
  max-width: 320px;
}

.form-header {
  margin-bottom: 40px;
}

.logo-box {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 32px;
}

.logo-icon {
  width: 40px;
  height: 40px;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 18px;
  color: var(--da-primary);
}

.logo-name {
  font-size: 20px;
  font-weight: 700;
  color: #fff;
}

.auth-form {
  display: flex;
  flex-direction: column;
  gap: 24px;
}

.input-container {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.input-wrapper {
  position: relative;
  display: flex;
  align-items: center;
}

.input-wrapper i {
  position: absolute;
  left: 16px;
  color: rgba(255, 255, 255, 0.4);
}

.input-wrapper input {
  width: 100%;
  padding: 14px 16px 14px 48px;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 14px;
  color: #fff;
}

.btn-primary {
  width: 100%;
  padding: 16px;
  background: linear-gradient(90deg, #0ea5e9, #2563eb);
  color: #fff;
  border: none;
  border-radius: 14px;
  font-weight: 700;
  cursor: pointer;
}

.form-footer {
  margin-top: 32px;
  text-align: center;
  font-size: 14px;
  color: rgba(255, 255, 255, 0.5);
}

.form-footer a {
  color: var(--da-primary);
  text-decoration: none;
  font-weight: 700;
  margin-left: 6px;
  transition: all 0.2s;
}

.form-footer a:hover {
  filter: brightness(1.2);
}

@media (max-width: 1100px) {
  .branding {
    display: none;
  }
  .form-panel {
    flex: 1;
  }
}
</style>
