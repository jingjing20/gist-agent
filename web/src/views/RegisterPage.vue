<template>
  <div class="auth-page">
    <div class="auth-card">
      <h1>注册</h1>
      <form @submit.prevent="handleRegister">
        <div class="form-row">
          <label>邮箱</label>
          <input v-model="email" type="email" placeholder="you@example.com" required />
        </div>
        <div class="form-row">
          <label>密码</label>
          <input v-model="password" type="password" placeholder="至少 6 位" required />
        </div>
        <div class="form-row">
          <label>昵称（可选）</label>
          <input v-model="name" type="text" placeholder="显示名称" />
        </div>
        <div v-if="error" class="form-error">{{ error }}</div>
        <button type="submit" class="btn-primary" :disabled="loading">
          {{ loading ? '注册中...' : '注册' }}
        </button>
      </form>
      <p class="auth-footer">
        已有账号？<router-link to="/login">登录</router-link>
      </p>
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
const name = ref('');
const error = ref('');
const loading = ref(false);

async function handleRegister() {
  error.value = '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.value)) {
    error.value = '请输入正确的邮箱格式';
    return;
  }
  loading.value = true;
  try {
    await authStore.register(email.value, password.value, name.value || undefined);
    router.replace('/');
  } catch (e: any) {
    error.value = e.message || '注册失败';
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
  background: var(--bg-primary);
}

.auth-card {
  width: 360px;
  padding: 32px;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 16px;
}

.auth-card h1 {
  font-size: 22px;
  font-weight: 600;
  color: var(--text-primary);
  margin-bottom: 24px;
}

.form-row {
  margin-bottom: 16px;
}

.form-row label {
  display: block;
  font-size: 12px;
  color: var(--text-secondary);
  margin-bottom: 6px;
}

.form-row input {
  width: 100%;
  padding: 10px 12px;
  font-size: 14px;
  background: var(--bg-primary);
  border: 1px solid var(--border);
  color: var(--text-primary);
  border-radius: 8px;
  box-sizing: border-box;
}

.form-row input:focus {
  outline: none;
  border-color: var(--accent);
}

.form-error {
  font-size: 12px;
  color: #f87171;
  margin-bottom: 12px;
}

.btn-primary {
  width: 100%;
  padding: 12px;
  font-size: 14px;
  font-weight: 500;
  background: var(--accent);
  color: #fff;
  border: none;
  border-radius: 8px;
  cursor: pointer;
  transition: background 0.15s;
}

.btn-primary:hover:not(:disabled) {
  background: var(--accent-hover);
}

.btn-primary:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.auth-footer {
  margin-top: 20px;
  font-size: 13px;
  color: var(--text-secondary);
  text-align: center;
}

.auth-footer a {
  color: var(--accent);
  text-decoration: none;
}

.auth-footer a:hover {
  text-decoration: underline;
}
</style>
