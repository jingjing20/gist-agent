import assert from 'node:assert/strict';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import ts from 'typescript';

const path = new URL('./.conversation-deletion-test.mjs', import.meta.url);
const source = (await readFile(new URL('../src/stores/chat.ts', import.meta.url), 'utf8'))
    .replace("import { defineStore } from 'pinia';", 'const defineStore = (_id, setup) => setup;')
    .replace("import { useRouter } from 'vue-router';", 'const useRouter = () => ({ replace: async () => {} });')
    .replace("import { apiFetch } from '../api';", 'const apiFetch = (...args) => globalThis.__deleteFetch(...args);')
    .replace("import { useToastStore } from './toast';", 'const useToastStore = () => ({});');
try {
    await writeFile(path, ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText);
    const { useChatStore } = await import(path.href);
    const store = useChatStore();
    const target = '6d452473-0e53-4013-91e4-2d3a3654a648';
    store.conversations.value = [{ id: target }, { id: 'other' }];
    store.activeConversationId.value = target;
    globalThis.__deleteFetch = async (url, options) => {
        assert.equal(url, `/conversations/${target}`);
        assert.equal(options.method, 'DELETE');
        return { ok: false, json: async () => ({ message: '删除失败' }) };
    };
    await assert.rejects(store.deleteConversation(target), /删除失败/);
    assert.deepEqual(
        store.conversations.value.map((c) => c.id),
        [target, 'other']
    );
    assert.equal(store.activeConversationId.value, target, '接口失败时列表和选中状态均保留');
    globalThis.__deleteFetch = async () => ({
        ok: false,
        json: async () => {
            throw new Error('not json');
        },
    });
    await assert.rejects(store.deleteConversation(target), /删除失败，请重试/);
    globalThis.__deleteFetch = async () => {
        throw new Error('network failed');
    };
    await assert.rejects(store.deleteConversation(target), /network failed/);
    assert.equal(store.conversations.value.length, 2);
    store.activeConversationId.value = null;
    globalThis.__deleteFetch = async () => ({ ok: true });
    await store.deleteConversation(target);
    assert.deepEqual(
        store.conversations.value.map((c) => c.id),
        ['other'],
        '只有服务端成功后移除目标对话'
    );
    console.log('PASS conversation deletion: failed HTTP/network preserves state; successful deletion removes target (mock API)');
} finally {
    delete globalThis.__deleteFetch;
    await unlink(path).catch(() => {});
}
