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
                    <h2 class="hero-title">你的数据，<br />由 AI 深度解析</h2>
                    <p class="hero-desc">集成最新 LLM 技术，支持上传 CSV/Excel 文件。自然语言一键对话，自动生成精美 ECharts 动态图表。</p>
                </div>
            </div>

            <!-- Right: Form -->
            <div class="form-panel">
                <div class="form-container">
                    <div class="form-header">
                        <h3>加入我们</h3>
                        <p>开启您的智能数据分析之旅</p>
                    </div>

                    <form @submit.prevent="handleRegister" class="auth-form">
                        <FieldGroup>
                            <Field><FieldLabel for="auth-email">邮箱</FieldLabel><Input id="auth-email" v-model="email" type="email" placeholder="name@company.com" required /></Field>
                            <Field><FieldLabel for="auth-password">密码</FieldLabel><Input id="auth-password" v-model="password" type="password" placeholder="设置至少 6 位密码" required /></Field>
                            <Field><FieldLabel for="auth-name">昵称</FieldLabel><Input id="auth-name" v-model="name" type="text" placeholder="您的昵称（可选）" /></Field>
                        </FieldGroup>

                        <div v-if="error" class="form-error">
                            <i class="fas fa-exclamation-circle"></i>
                            {{ error }}
                        </div>

                        <Button type="submit" class="w-full" :disabled="loading">
                            <span v-if="!loading">立即注册</span>
                            <span v-else class="loading-spinner"><i class="fas fa-spinner fa-spin"></i> 处理中...</span>
                        </Button>
                    </form>

                    <div class="form-footer">已有账号？<router-link to="/login">返回登录</router-link></div>
                </div>
            </div>
        </div>
    </div>
</template>

<script setup lang="ts">
import { Button } from '@/components/ui/button';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth';
import { useToastStore } from '../stores/toast';

const router = useRouter();
const authStore = useAuthStore();
const toast = useToastStore();

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
        toast.success('注册成功，欢迎加入');
        router.replace('/chat');
    } catch (e: any) {
        error.value = e.message || '注册失败';
        toast.error('注册失败: ' + error.value);
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
    flex-direction: column;
    justify-content: flex-start;
    align-items: flex-start;
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
