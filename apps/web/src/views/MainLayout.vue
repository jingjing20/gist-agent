<template>
    <div class="app-root">
        <header class="app-header">
            <div class="header-brand">
                <div class="logo-icon"><ChartNoAxesCombined /></div>
                <span class="brand-text">Gist Agent</span>
            </div>
            <nav class="header-tabs" aria-label="主导航">
                <Button :variant="activeTab === 'chat' ? 'secondary' : 'ghost'" size="sm" @click="router.push('/chat')">开始分析</Button>
                <Button :variant="activeTab === 'datasource' ? 'secondary' : 'ghost'" size="sm" @click="goToDataSource">数据源</Button>
                <Button :variant="activeTab === 'memories' ? 'secondary' : 'ghost'" size="sm" @click="router.push('/memories')">记忆</Button>
            </nav>
            <div class="header-user">
                <DropdownMenu>
                    <DropdownMenuTrigger as-child>
                        <Button variant="ghost" size="icon" aria-label="切换主题"><Sun v-if="mode === 'dark'" /><Moon v-else /></Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" class="min-w-36">
                        <DropdownMenuGroup>
                            <DropdownMenuItem @select="mode = 'light'">浅色</DropdownMenuItem>
                            <DropdownMenuItem @select="mode = 'dark'">深色</DropdownMenuItem>
                            <DropdownMenuItem @select="mode = 'auto'">跟随系统</DropdownMenuItem>
                        </DropdownMenuGroup>
                    </DropdownMenuContent>
                </DropdownMenu>
                <DropdownMenu>
                    <DropdownMenuTrigger as-child>
                        <Button variant="ghost" class="user-trigger">
                            <Avatar class="size-7"><AvatarImage src="https://api.dicebear.com/7.x/notionists/svg?seed=GistAgent" alt="" /><AvatarFallback>{{ userInitial }}</AvatarFallback></Avatar>
                            <span class="user-name">{{ authStore.user?.name || authStore.user?.email }}</span>
                            <ChevronDown />
                        </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" class="min-w-44">
                        <DropdownMenuGroup>
                            <DropdownMenuItem @select="openProfileModal">个人信息</DropdownMenuItem>
                            <DropdownMenuItem @select="openPasswordModal">修改密码</DropdownMenuItem>
                            <DropdownMenuItem as-child><a href="https://github.com/jingjing20/gist-agent" target="_blank" rel="noopener noreferrer">GitHub 地址</a></DropdownMenuItem>
                        </DropdownMenuGroup>
                        <DropdownMenuSeparator />
                        <DropdownMenuGroup><DropdownMenuItem @select="handleLogout">退出登录</DropdownMenuItem></DropdownMenuGroup>
                    </DropdownMenuContent>
                </DropdownMenu>
            </div>
        </header>
        <div class="app-body"><router-view /></div>

        <Dialog v-model:open="profileModalVisible">
            <DialogContent class="sm:max-w-md">
                <DialogHeader><DialogTitle>个人信息</DialogTitle><DialogDescription>查看邮箱并修改显示名称。</DialogDescription></DialogHeader>
                <FieldGroup>
                    <Field><FieldLabel for="profile-email">邮箱</FieldLabel><Input id="profile-email" :model-value="authStore.user?.email" disabled /></Field>
                    <Field><FieldLabel for="profile-name">用户名</FieldLabel><Input id="profile-name" v-model="profileForm.name" /></Field>
                </FieldGroup>
                <DialogFooter><Button variant="outline" @click="profileModalVisible = false">取消</Button><Button @click="submitProfile">保存</Button></DialogFooter>
            </DialogContent>
        </Dialog>
        <Dialog v-model:open="passwordModalVisible">
            <DialogContent class="sm:max-w-md">
                <DialogHeader><DialogTitle>修改密码</DialogTitle><DialogDescription>新密码至少需要 6 个字符。</DialogDescription></DialogHeader>
                <FieldGroup>
                    <Field><FieldLabel for="new-password">新密码</FieldLabel><Input id="new-password" v-model="passwordForm.password" type="password" placeholder="请输入新密码" /></Field>
                    <Field><FieldLabel for="confirm-password">确认新密码</FieldLabel><Input id="confirm-password" v-model="passwordForm.confirmPassword" type="password" placeholder="请确认新密码" /></Field>
                </FieldGroup>
                <DialogFooter><Button variant="outline" @click="passwordModalVisible = false">取消</Button><Button @click="submitPassword">提交</Button></DialogFooter>
            </DialogContent>
        </Dialog>
    </div>
</template>

<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import { useColorMode } from '@vueuse/core';
import { useRouter, useRoute } from 'vue-router';
import { ChartNoAxesCombined, ChevronDown, Moon, Sun } from '@lucide/vue';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { useDataSourceStore } from '../stores/datasource';
import { useAuthStore } from '../stores/auth';
import { useToastStore } from '../stores/toast';

const router = useRouter();
const route = useRoute();
const dsStore = useDataSourceStore();
const authStore = useAuthStore();
const toast = useToastStore();
const mode = useColorMode();
const activeTab = computed(() => (route.name === 'memories' ? 'memories' : route.name === 'datasource' ? 'datasource' : 'chat'));
const userInitial = computed(() => (authStore.user?.name || authStore.user?.email || 'U').charAt(0).toUpperCase());
const profileModalVisible = ref(false);
const passwordModalVisible = ref(false);
const profileForm = reactive({ name: '' });
const passwordForm = reactive({ password: '', confirmPassword: '' });

function goToDataSource() {
    router.push('/datasource');
    dsStore.fetchAll();
}
function openProfileModal() {
    profileForm.name = authStore.user?.name || '';
    profileModalVisible.value = true;
}
function openPasswordModal() {
    passwordForm.password = '';
    passwordForm.confirmPassword = '';
    passwordModalVisible.value = true;
}
async function submitProfile() {
    if (!profileForm.name.trim()) return toast.error('用户名不能为空');
    try {
        await authStore.updateProfile(profileForm.name);
        toast.success('个人信息已更新');
        profileModalVisible.value = false;
    } catch (err: any) {
        toast.error(err.message || '更新失败');
    }
}
async function submitPassword() {
    if (!passwordForm.password || passwordForm.password.length < 6) return toast.error('密码至少需要 6 个字符');
    if (passwordForm.password !== passwordForm.confirmPassword) return toast.error('两次输入的密码不一致');
    try {
        await authStore.updatePassword(passwordForm.password);
        toast.success('密码修改成功');
        passwordModalVisible.value = false;
    } catch (err: any) {
        toast.error(err.message || '修改密码失败');
    }
}
function handleLogout() {
    authStore.logout();
    toast.info('已退出登录');
    router.push('/login');
}
</script>

<style scoped>
.app-root { display: flex; flex-direction: column; height: 100vh; width: 100vw; overflow: hidden; background: var(--da-bg); color: var(--da-text-main); }
.app-header { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 0 24px; height: 64px; border-bottom: 1px solid var(--da-border); background: var(--da-panel); flex-shrink: 0; }
.header-brand, .header-tabs, .header-user { display: flex; align-items: center; gap: 12px; }
.header-brand { min-width: 180px; }
.header-tabs { gap: 4px; }
.header-user { justify-content: flex-end; min-width: 180px; }
.logo-icon { display: flex; align-items: center; justify-content: center; width: 32px; height: 32px; color: var(--da-primary); }
.brand-text { font-size: 18px; font-weight: 600; white-space: nowrap; }
.user-trigger { gap: 8px; max-width: 220px; }
.user-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.app-body { flex: 1; display: flex; overflow: hidden; }
@media (max-width: 700px) { .app-header { padding: 0 12px; } .header-brand { min-width: 0; } .brand-text, .user-name, .user-trigger :deep(svg:last-child) { display: none; } .header-user { min-width: 0; } }
</style>
