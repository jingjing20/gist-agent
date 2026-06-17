<template>
    <Teleport to="body">
        <div v-if="modelValue" class="modal-overlay">
            <div class="modal da-modal grant-modal">
                <button class="modal-close" @click="emit('update:modelValue', null)">
                    <i class="fas fa-times"></i>
                </button>
                <h3>权限管理: {{ modelValue.name }}</h3>

                <div class="granted-list-section">
                    <label class="section-label">现有成员</label>
                    <div class="user-strip-list no-scrollbar">
                        <div v-for="u in grantedUsers" :key="u.id" class="user-strip">
                            <div class="user-info">
                                <div class="u-name">{{ u.name }}</div>
                                <div class="u-email">{{ u.email }}</div>
                            </div>
                            <span v-if="u.id === authUser?.id" class="owner-badge">所有者</span>
                            <button v-else class="revoke-btn" @click="emit('revoke', u.id)">
                                <i class="fas fa-user-minus"></i>
                            </button>
                        </div>
                    </div>
                </div>

                <div class="search-grant-section">
                    <label class="section-label">添加成员</label>
                    <div class="search-input-box">
                        <i class="fas fa-search search-icon"></i>
                        <input v-model="searchQuery" placeholder="搜索邮箱或用户名..." @input="handleSearch" />
                    </div>
                    <div v-if="searchResults.length" class="search-results-list no-scrollbar">
                        <div v-for="u in searchResults" :key="u.id" class="user-strip">
                            <div class="user-info">
                                <div class="u-name">{{ u.name }}</div>
                                <div class="u-email">{{ u.email }}</div>
                            </div>
                            <button v-if="!grantedUsers.some((gu) => gu.id === u.id) && u.id !== authUser?.id" class="grant-action-btn" @click="emit('grant', u.id)">
                                <i class="fas fa-plus"></i>
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    </Teleport>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue';
import type { DataSource } from '../../stores/datasource';

const props = defineProps<{
    modelValue: DataSource | null;
    grantedUsers: any[];
    searchResults: any[];
    authUser: any;
}>();

watch(
    () => props.modelValue,
    (val) => {
        if (val) {
            searchQuery.value = '';
            emit('search', '');
        }
    }
);

const emit = defineEmits<{
    (e: 'update:modelValue', value: DataSource | null): void;
    (e: 'search', query: string): void;
    (e: 'grant', userId: number): void;
    (e: 'revoke', userId: number): void;
}>();

const searchQuery = ref('');

function handleSearch() {
    emit('search', searchQuery.value);
}
</script>

<style scoped>
/* modal-overlay is now global in style.css */

.modal {
    background: var(--da-panel);
    border: 1px solid var(--da-border);
    border-radius: 20px;
    padding: 32px;
    box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5);
    animation: modal-pop 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
}

@keyframes modal-pop {
    from {
        opacity: 0;
        transform: scale(0.95);
    }
    to {
        opacity: 1;
        transform: scale(1);
    }
}

.modal h3 {
    font-size: 20px;
    font-weight: 700;
    color: #fff;
    margin-bottom: 24px;
    margin-top: 0;
}

.grant-modal {
    width: 440px;
}
.section-label {
    font-size: 12px;
    font-weight: 700;
    color: var(--da-text-muted);
    text-transform: uppercase;
    display: block;
    margin-bottom: 12px;
}

.user-strip-list {
    max-height: 200px;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-bottom: 24px;
}
.user-strip {
    background: rgba(255, 255, 255, 0.03);
    border-radius: 10px;
    padding: 10px 14px;
    display: flex;
    justify-content: space-between;
    align-items: center;
}
.u-name {
    font-size: 14px;
    font-weight: 600;
    color: #fff;
}
.u-email {
    font-size: 12px;
    color: var(--da-text-muted);
}

.owner-badge {
    font-size: 10px;
    background: rgba(14, 165, 233, 0.15);
    color: var(--da-primary);
    padding: 2px 8px;
    border-radius: 4px;
}
.revoke-btn {
    background: none;
    border: none;
    color: var(--da-text-muted);
    cursor: pointer;
    transition: color 0.2s;
}
.revoke-btn:hover {
    color: #ef4444;
}

.search-input-box {
    position: relative;
    margin-bottom: 12px;
}
.search-icon {
    position: absolute;
    left: 14px;
    top: 50%;
    transform: translateY(-50%);
    color: var(--da-text-muted);
}
.search-input-box input {
    width: 100%;
    background: var(--da-bg);
    border: 1px solid var(--da-border);
    border-radius: 10px;
    padding: 10px 14px 10px 40px;
    color: #fff;
    outline: none;
    transition: border-color 0.2s;
}
.search-input-box input:focus {
    border-color: var(--da-primary);
}

.search-results-list {
    max-height: 150px;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 4px;
}

.grant-action-btn {
    background: var(--da-primary);
    color: #fff;
    border: none;
    border-radius: 6px;
    width: 28px;
    height: 28px;
    cursor: pointer;
    transition: all 0.2s;
}
.grant-action-btn:hover {
    background: var(--da-primary-hover);
    transform: scale(1.1);
}

.no-scrollbar::-webkit-scrollbar {
    display: none;
}
.no-scrollbar {
    -ms-overflow-style: none;
    scrollbar-width: none;
}
</style>
