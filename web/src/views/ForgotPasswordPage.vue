<template>
  <div class="auth-page">
    <div class="auth-card">
      <h1>忘记密码</h1>
      <template v-if="!sent">
        <form @submit.prevent="handleSubmit">
          <div class="form-row">
            <label>注册邮箱</label>
            <input v-model="email" type="email" placeholder="you@example.com" required />
          </div>
          <div v-if="error" class="form-error">{{ error }}</div>
          <button type="submit" class="btn-primary" :disabled="loading">
            {{ loading ? '发送中...' : '发送重置链接' }}
          </button>
        </form>
      </template>
      <template v-else>
        <p class="sent-tip">若该邮箱已注册，重置链接已发送，请查收邮件。</p>
        <p class="sent-tip secondary">链接 15 分钟内有效。</p>
      </template>
      <p class="auth-footer">
        <router-link to="/login">返回登录</router-link>
      </p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';

const API_BASE = '/api';

const email = ref('');
const error = ref('');
const loading = ref(false);
const sent = ref(false);

async function handleSubmit() {
  error.value = '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.value)) {
    error.value = '请输入正确的邮箱格式';
    return;
  }
  loading.value = true;
  try {
    const res = await fetch(`${API_BASE}/auth/forgot-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: email.value,
        origin: window.location.origin
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || '请求失败');
    sent.value = true;
  } catch (e: any) {
    error.value = e.message || '请求失败，请稍后重试';
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

.sent-tip {
  font-size: 14px;
  color: var(--text-primary);
  line-height: 1.6;
  margin-bottom: 6px;
}

.sent-tip.secondary {
  font-size: 12px;
  color: var(--text-secondary);
  margin-bottom: 0;
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
