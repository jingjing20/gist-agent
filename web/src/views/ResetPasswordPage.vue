<template>
  <div class="auth-page">
    <div class="auth-card">
      <h1>重置密码</h1>
      <template v-if="!done">
        <form @submit.prevent="handleSubmit">
          <div class="form-row">
            <label>新密码</label>
            <input v-model="password" type="password" placeholder="至少 6 位" required />
          </div>
          <div class="form-row">
            <label>确认新密码</label>
            <input v-model="confirm" type="password" placeholder="再次输入密码" required />
          </div>
          <div v-if="error" class="form-error">{{ error }}</div>
          <button type="submit" class="btn-primary" :disabled="loading">
            {{ loading ? '提交中...' : '确认重置' }}
          </button>
        </form>
      </template>
      <template v-else>
        <p class="done-tip">密码已重置，请使用新密码登录。</p>
      </template>
      <p class="auth-footer">
        <router-link to="/login">返回登录</router-link>
      </p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useRouter, useRoute } from 'vue-router';

const API_BASE = '/api';

const router = useRouter();
const route = useRoute();

const token = ref('');
const password = ref('');
const confirm = ref('');
const error = ref('');
const loading = ref(false);
const done = ref(false);

onMounted(() => {
  token.value = (route.query.token as string) ?? '';
  if (!token.value) {
    error.value = '无效的重置链接';
  }
});

async function handleSubmit() {
  error.value = '';
  if (password.value !== confirm.value) {
    error.value = '两次输入的密码不一致';
    return;
  }
  loading.value = true;
  try {
    const res = await fetch(`${API_BASE}/auth/reset-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: token.value, password: password.value }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || '重置失败');
    done.value = true;
    setTimeout(() => router.replace('/login'), 2000);
  } catch (e: any) {
    error.value = e.message || '重置失败，请稍后重试';
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

.done-tip {
  font-size: 14px;
  color: var(--text-primary);
  line-height: 1.6;
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
