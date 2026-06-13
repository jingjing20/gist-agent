<template>
  <div class="auth-page">
    <div class="glass-card">
      <!-- Left: Branding -->
      <div class="branding">
        <div class="logo-box">
          <div class="logo-icon">
            <i class="fas fa-chart-line"></i>
          </div>
          <span class="logo-name">Gist Agent</span>
        </div>
        <div class="branding-content">
          <h2 class="hero-title">安全第一，<br />守护您的数据</h2>
          <p class="hero-desc">
            请输入您的注册邮箱，我们将为您发送一条安全的密码重置链接。
          </p>
        </div>
      </div>

      <!-- Right: Form -->
      <div class="form-panel">
        <div class="form-container">
          <div class="form-header">
            <h3>重置密码</h3>
            <p>找回您的账号访问权限</p>
          </div>

          <form @submit.prevent="handleSubmit" class="auth-form">
            <div class="input-group">
              <div class="input-wrapper">
                <i class="far fa-envelope"></i>
                <input
                  v-model="email"
                  type="email"
                  placeholder="输入注册邮箱"
                  required
                />
              </div>
            </div>

            <div v-if="error" class="form-error">
              <i class="fas fa-exclamation-circle"></i>
              {{ error }}
            </div>

            <div v-if="success" class="form-success">
              <i class="fas fa-check-circle"></i>
              重置链接已发送到邮箱
            </div>

            <button
              type="submit"
              class="btn-primary"
              :disabled="loading || success"
            >
              <span v-if="!loading">发送重置链接</span>
              <span v-else class="loading-spinner"
                ><i class="fas fa-spinner fa-spin"></i> 发送中...</span
              >
            </button>
          </form>

          <div class="form-footer">
            想起密码了？<router-link to="/login">返回登录</router-link>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from "vue";
import { apiFetch } from "../api";
import { useToastStore } from "../stores/toast";

const email = ref("");
const loading = ref(false);
const error = ref("");
const success = ref(false);
const toast = useToastStore();

async function handleSubmit() {
  loading.value = true;
  error.value = "";
  try {
    const res = await apiFetch("/auth/request-reset", {
      method: "POST",
      body: JSON.stringify({
        email: email.value,
        origin: window.location.origin,
      }),
    });
    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.message || "发送失败");
    }
    success.value = true;
    toast.success("重置邮件已发送");
  } catch (e: any) {
    error.value = e.message;
    toast.error("重置请求失败: " + error.value);
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
  flex-direction: column;
  justify-content: flex-start;
  align-items: flex-start;
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
  margin-top: auto;
  margin-bottom: auto;
  max-width: 440px;
}

.logo-box {
  display: flex;
  align-items: center;
  gap: 20px;
}

.logo-icon {
  width: 72px;
  height: 72px;
  background: linear-gradient(135deg, var(--da-primary), #8b5cf6);
  border-radius: 18px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 32px;
  color: #fff;
  flex-shrink: 0;
  box-shadow: 0 12px 32px rgba(14, 165, 233, 0.3);
}

.logo-name {
  font-size: 32px;
  font-weight: 850;
  color: #fff;
  margin: 0;
  letter-spacing: -0.03em;
}

.hero-title {
  font-size: 52px;
  font-weight: 800;
  color: #fff;
  line-height: 1.15;
  margin-bottom: 28px;
  letter-spacing: -0.02em;
  background: linear-gradient(135deg, #fff 0%, rgba(255, 255, 255, 0.7) 100%);
  background-clip: text;
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
}

.hero-desc {
  font-size: 16px;
  color: rgba(255, 255, 255, 0.5);
  line-height: 1.8;
  letter-spacing: 0.02em;
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

.form-header h3 {
  font-size: 24px;
  font-weight: 700;
  color: #fff;
  margin-bottom: 8px;
}

.form-header p {
  font-size: 14px;
  color: rgba(255, 255, 255, 0.5);
}

.auth-form {
  display: flex;
  flex-direction: column;
  gap: 24px;
}

.input-group {
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
  font-size: 16px;
}

.input-wrapper input {
  width: 100%;
  padding: 14px 16px 14px 48px;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 14px;
  color: #fff;
  font-size: 14px;
}

.form-error {
  padding: 12px;
  background: rgba(239, 68, 68, 0.15);
  border-radius: 12px;
  color: #fca5a5;
  font-size: 13px;
}

.form-success {
  padding: 12px;
  background: rgba(34, 197, 94, 0.15);
  border-radius: 12px;
  color: #86efac;
  font-size: 13px;
}

.btn-primary {
  width: 100%;
  padding: 16px;
  background: linear-gradient(90deg, #0ea5e9, #2563eb);
  color: #fff;
  border: none;
  border-radius: 14px;
  font-size: 15px;
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
  .glass-card {
    max-width: 500px;
    min-height: auto;
  }
}
</style>
