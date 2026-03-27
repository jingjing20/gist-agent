<template>
  <div class="auth-page">
    <div class="glass-card">
      <!-- Left: Branding -->
      <div class="branding">
        <div class="branding-content">
          <h1 class="logo-text">Gist Agent</h1>
          <h2 class="hero-title">你的数据，<br />由 AI 深度解析</h2>
          <p class="hero-desc">
            集成最新 LLM 技术，支持上传 CSV/Excel 文件。自然语言一键对话，自动生成精美 ECharts 动态图表。
          </p>
        </div>
      </div>

      <!-- Right: Form -->
      <div class="form-panel">
        <div class="form-container">
          <div class="form-header">
            <div class="logo-box">
              <div class="logo-icon">
                <i class="fas fa-chart-line"></i>
              </div>
              <span class="logo-name">Gist Agent</span>
            </div>
            <h3>欢迎回来</h3>
            <p>登录您的 Gist Agent 账号</p>
          </div>

          <form @submit.prevent="handleLogin" class="auth-form">
            <div class="input-group">
              <div class="input-wrapper">
                <i class="far fa-envelope"></i>
                <input v-model="email" type="email" placeholder="name@company.com" required />
              </div>
            </div>

            <div class="input-group">
              <div class="input-wrapper">
                <i class="fas fa-lock"></i>
                <input v-model="password" type="password" placeholder="••••••••" required />
              </div>
              <div class="forgot-box">
                <router-link to="/forgot-password" class="forgot-link">忘记密码？</router-link>
              </div>
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

          <div class="form-footer">
            还没有账号？<router-link to="/register">免费注册</router-link>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth';
import { useToastStore } from '../stores/toast';

const router = useRouter();
const authStore = useAuthStore();
const toast = useToastStore();

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
    toast.success('登录成功，欢迎回来');
    router.replace('/chat');
  } catch (e: any) {
    error.value = e.message || '登录失败';
    toast.error('登录失败: ' + error.value);
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
  background-image: url('../assets/images/auth_bg.png');
  background-size: cover;
  background-position: center;
  overflow: hidden;
  padding: 40px;
}

.glass-card {
  display: flex;
  width: 100%;
  max-width: 1100px;
  min-height: 640px;
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
  content: '';
  position: absolute;
  top: 10%;
  right: 0;
  bottom: 10%;
  width: 1px;
  background: linear-gradient(to bottom, transparent, rgba(255, 255, 255, 0.1), transparent);
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
  background: var(--da-primary);
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 18px;
  color: #fff;
  box-shadow: 0 8px 20px rgba(14, 165, 233, 0.3);
}

.logo-name {
  font-size: 20px;
  font-weight: 700;
  color: #fff;
  letter-spacing: -0.01em;
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
  transition: all 0.2s;
}

.input-wrapper input:focus {
  outline: none;
  border-color: var(--da-primary);
  background: rgba(14, 165, 233, 0.05);
  box-shadow: 0 0 0 4px rgba(14, 165, 233, 0.15);
}

.forgot-box {
  display: flex;
  justify-content: flex-end;
  margin-top: 4px;
}

.forgot-link {
  font-size: 14px;
  color: var(--da-primary);
  font-weight: 700;
  text-decoration: none;
  opacity: 0.8;
  transition: all 0.2s;
}

.forgot-link:hover {
  opacity: 1;
}

.form-error {
  padding: 12px;
  background: rgba(239, 68, 68, 0.15);
  border-radius: 12px;
  color: #fca5a5;
  font-size: 13px;
  display: flex;
  align-items: center;
  gap: 10px;
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
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  box-shadow: 0 10px 25px -5px rgba(14, 165, 233, 0.4);
}

.btn-primary:hover:not(:disabled) {
  transform: translateY(-2px);
  box-shadow: 0 15px 30px -5px rgba(14, 165, 233, 0.6);
  filter: brightness(1.1);
}

.btn-primary:active {
  transform: translateY(0);
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
  .branding { display: none; }
  .form-panel { flex: 1; }
  .glass-card { max-width: 500px; min-height: auto; }
}
</style>
