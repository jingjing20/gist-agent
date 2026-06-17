import { defineStore } from 'pinia';
import { ref, computed } from 'vue';

import { useDataSourceStore } from './datasource';
import { useChatStore } from './chat';

const API_BASE = '/api';
const TOKEN_KEY = 'auth_token';

export const useAuthStore = defineStore('auth', () => {
    const token = ref<string | null>(localStorage.getItem(TOKEN_KEY));
    const user = ref<{ id: number; email: string; name: string } | null>(null);

    const isLoggedIn = computed(() => !!token.value);

    async function fetchUser() {
        if (!token.value) return;
        try {
            const res = await fetch(`${API_BASE}/auth/me`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${token.value}`,
                },
            });
            if (res.ok) {
                user.value = await res.json();
            } else {
                logout();
            }
        } catch {
            logout();
        }
    }

    async function login(email: string, password: string) {
        const res = await fetch(`${API_BASE}/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password }),
        });
        const data = await res.json();
        if (!res.ok) {
            throw new Error(data.message || '登录失败');
        }
        token.value = data.token;
        user.value = data.user;
        localStorage.setItem(TOKEN_KEY, data.token);
    }

    async function register(email: string, password: string, name?: string) {
        const res = await fetch(`${API_BASE}/auth/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password, name }),
        });
        const data = await res.json();
        if (!res.ok) {
            throw new Error(data.message || '注册失败');
        }
        token.value = data.token;
        user.value = data.user;
        localStorage.setItem(TOKEN_KEY, data.token);
    }

    async function updateProfile(name: string) {
        const res = await fetch(`${API_BASE}/users/profile`, {
            method: 'PUT',
            headers: authHeaders(),
            body: JSON.stringify({ name }),
        });
        const data = await res.json();
        if (!res.ok) {
            throw new Error(data.message || '更新信息失败');
        }
        if (user.value) {
            user.value.name = name;
        }
    }

    async function updatePassword(password: string) {
        const res = await fetch(`${API_BASE}/users/password`, {
            method: 'PUT',
            headers: authHeaders(),
            body: JSON.stringify({ password }),
        });
        const data = await res.json();
        if (!res.ok) {
            throw new Error(data.message || '修改密码失败');
        }
    }

    function logout() {
        token.value = null;
        user.value = null;
        localStorage.removeItem(TOKEN_KEY);
        try {
            useDataSourceStore().clear();
            useChatStore().clear();
        } catch (e) {
            console.error('Failed to clear stores on logout:', e);
        }
    }

    function authHeaders(): Record<string, string> {
        const h: Record<string, string> = { 'Content-Type': 'application/json' };
        if (token.value) h.Authorization = `Bearer ${token.value}`;
        return h;
    }

    return {
        token,
        user,
        isLoggedIn,
        fetchUser,
        login,
        register,
        logout,
        authHeaders,
        updateProfile,
        updatePassword,
    };
});
