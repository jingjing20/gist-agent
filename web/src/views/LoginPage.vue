<template>
  <div class="auth-page">
    <div class="mesh-bg"></div>
    <div class="auth-card">
      <div class="brand-header">
        <div class="brand-icon">
          <i class="fas fa-chart-line"></i>
        </div>
        <h1>欢迎回来</h1>
        <p>登录您的 DataAgent 账号</p>
      </div>

      <form @submit.prevent="handleLogin" class="auth-form">
        <div class="form-row">
          <label>邮箱地址</label>
          <div class="input-wrapper">
            <i class="fas fa-envelope"></i>
            <input v-model="email" type="email" placeholder="name@company.com" required />
          </div>
        </div>
        <div class="form-row">
          <label>密码</label>
          <div class="input-wrapper">
            <i class="fas fa-lock"></i>
            <input v-model="password" type="password" placeholder="••••••••" required />
          </div>
        </div>

        <div class="form-utils">
          <router-link to="/forgot-password" class="forgot-link">忘记密码？</router-link>
        </div>

        <div v-if="error" class="form-error">
          <i class="fas fa-exclamation-circle"></i>
          {{ error }}
        </div>

        <button type="submit" class="btn-primary" :disabled="loading">
          <span v-if="!loading">立即登录</span>
          <span v-else class="loading-spinner"><i class="fas fa-spinner fa-spin"></i> 处理中...</span>
        </button>
      </form>

      <div class="auth-footer">
        还没有账号？<router-link to="/register">免费注册</router-link>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth';

const router = useRouter();
const authStore = useAuthStore();

const email = ref('');
const password = ref('');
const error = ref('');
const loading = ref(false);

async function handleLogin() {
  error.value = '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.value)) {
    error.value = '请输入正确的邮箱格式';
    return;
  }
  loading.value = true;
  try {
    await authStore.login(email.value, password.value);
    router.replace('/');
  } catch (e: any) {
    error.value = e.message || '登录失败';
  } finally {
    loading.value = false;
  }
}
</script>

<style scoped>
.auth-page {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--da-bg);
  position: relative;
  overflow: hidden;
}

.mesh-bg {
  position: absolute;
  top: -50%;
  left: -50%;
  width: 200%;
  height: 200%;
  background: radial-gradient(circle at 50% 50%, rgba(14, 165, 233, 0.08), transparent 25%),
              radial-gradient(circle at 20% 30%, rgba(139, 92, 246, 0.08), transparent 25%);
  animation: mesh-rotate 30s linear infinite;
  z-index: 1;
}

@keyframes mesh-rotate {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.auth-card {
  width: 420px;
  padding: 40px;
  background: var(--da-panel);
  border: 1px solid var(--da-border);
  border-radius: 24px;
  box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5);
  position: relative;
  z-index: 2;
  backdrop-filter: blur(10px);
}

.brand-header {
  text-align: center;
  margin-bottom: 32px;
}

.brand-icon {
  width: 56px;
  height: 56px;
  background: linear-gradient(135deg, var(--da-primary), #8b5cf6);
  border-radius: 14px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 24px;
  color: #fff;
  margin: 0 auto 16px;
  box-shadow: 0 8px 16px rgba(14, 165, 233, 0.2);
}

.brand-header h1 {
  font-size: 24px;
  font-weight: 700;
  color: #fff;
  margin-bottom: 4px;
  letter-spacing: -0.02em;
}

.brand-header p {
  font-size: 14px;
  color: var(--da-text-muted);
}

.auth-form {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.form-row {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.form-row label {
  font-size: 13px;
  font-weight: 600;
  color: var(--da-text-muted);
}

.input-wrapper {
  position: relative;
  display: flex;
  align-items: center;
}

.input-wrapper i {
  position: absolute;
  left: 14px;
  color: var(--da-text-muted);
  font-size: 14px;
}

.input-wrapper input {
  width: 100%;
  padding: 12px 14px 12px 40px;
  background: var(--da-card);
  border: 1px solid var(--da-border);
  border-radius: 12px;
  color: #fff;
  font-size: 14px;
  transition: all 0.2s;
}

.input-wrapper input:focus {
  outline: none;
  border-color: var(--da-primary);
  background: rgba(14, 165, 233, 0.05);
  box-shadow: 0 0 0 4px rgba(14, 165, 233, 0.1);
}

.form-utils {
  display: flex;
  justify-content: flex-end;
}

.forgot-link {
  font-size: 13px;
  color: var(--da-primary);
  text-decoration: none;
  font-weight: 500;
}

.form-error {
  padding: 12px;
  background: rgba(239, 68, 68, 0.1);
  border: 1px solid rgba(239, 68, 68, 0.2);
  border-radius: 10px;
  color: #f87171;
  font-size: 13px;
  display: flex;
  align-items: center;
  gap: 8px;
}

.btn-primary {
  width: 100%;
  padding: 14px;
  background: var(--da-primary);
  color: #fff;
  border: none;
  border-radius: 12px;
  font-size: 15px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s;
  margin-top: 8px;
}

.btn-primary:hover:not(:disabled) {
  background: var(--da-primary-hover);
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(14, 165, 233, 0.3);
}

.btn-primary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.auth-footer {
  margin-top: 32px;
  text-align: center;
  font-size: 14px;
  color: var(--da-text-muted);
}

.auth-footer a {
  color: var(--da-primary);
  text-decoration: none;
  font-weight: 600;
}

.loading-spinner {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
}
</style>
