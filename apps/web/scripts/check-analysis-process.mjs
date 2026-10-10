import assert from 'node:assert/strict';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { parse, compileScript } from 'vue/compiler-sfc';
import ts from 'typescript';
import { createRenderer, h, reactive, nextTick } from 'vue';

const source = (await readFile(new URL('../src/components/blocks/AnalysisProcessBlock.vue', import.meta.url), 'utf8'))
    .replace("import { apiFetch } from '../../api';", 'const apiFetch = () => { throw new Error("Unexpected request"); };')
    .replace("import { useChatStore } from '../../stores/chat';", 'const useChatStore = () => ({});')
    .replace("import { cloneAnalysisActivity } from '../../utils/analysis-activity.js';", "import { cloneAnalysisActivity } from '../src/utils/analysis-activity.js';")
    .replace(/import (SqlBlock|TableBlock) from '[^']+';/g, 'const $1 = { render: () => null };');
const { descriptor } = parse(source);
const compiled = compileScript(descriptor, { id: 'analysis-process-test', inlineTemplate: true });
const modulePath = new URL('./.analysis-process-component.mjs', import.meta.url);
await writeFile(modulePath, ts.transpileModule(compiled.content, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText);
const renderer = createRenderer({
    createElement: () => ({ children: [], props: {} }),
    createText: (text) => ({ text }),
    createComment: () => ({}),
    insert: (node, parent, anchor) => {
        if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1);
        node.parent = parent;
        const index = parent.children.indexOf(anchor);
        parent.children.splice(index < 0 ? parent.children.length : index, 0, node);
    },
    remove: (node) => {
        if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1);
    },
    setText: (node, text) => {
        node.text = text;
    },
    setElementText: (node, text) => {
        node.text = text;
        node.children = [];
    },
    parentNode: (node) => node.parent,
    nextSibling: (node) => node.parent?.children[node.parent.children.indexOf(node) + 1],
    patchProp: (node, key, previous, value) => {
        node.props[key] = value;
    },
});
const chatModulePath = new URL('./.chat-process-component.mjs', import.meta.url);
const chatSource = (await readFile(new URL('../src/components/ChatMessageItem.vue', import.meta.url), 'utf8'))
    .replace("import { textPlaybackKey } from '../utils/text-playback';", 'const textPlaybackKey = Symbol.for("test-text-playback");')
    .replace("import { useChatStore } from '../stores/chat';", 'const useChatStore = () => globalThis.__suggestionTestChat;')
    .replace(/import (\w+) from '[^']+\.vue';/g, (match, name) => {
        if (name === 'AnalysisProcessBlock') return 'const AnalysisProcessBlock = { render: () => testH("section", { class: "process-probe" }) };';
        if (name === 'SuggestionBlock')
            return 'const SuggestionBlock = { props: ["items", "disabled"], emits: ["select"], render() { return testH("button", { class: "suggestion-probe", disabled: this.disabled, onClick: () => this.$emit("select", this.items[0].text) }); } };';
        return `const ${name} = { render: () => null };`;
    });
const chatDescriptor = parse(chatSource.replace('<script setup lang="ts">', '<script setup lang="ts">\nimport { h as testH } from "vue";')).descriptor;
await writeFile(
    chatModulePath,
    ts.transpileModule(compileScript(chatDescriptor, { id: 'chat-process-test', inlineTemplate: true }).content, {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    }).outputText
);
let app;
try {
    const { default: Component } = await import(modulePath.href);
    const activity = {
        version: 1,
        id: 'query',
        groupId: 'round',
        kind: 'query_data',
        label: '查询数据',
        status: 'running',
        startedAt: new Date().toISOString(),
        details: [{ label: '查询目的', value: '统计回款' }],
    };
    const props = reactive({ blocks: [{ type: 'analysis_activity', activity }], isStreaming: true });
    const root = { children: [] };
    app = renderer.createApp({ render: () => h(Component, props) });
    app.mount(root);
    const nodes = () => {
        const all = [];
        const visit = (node) => {
            all.push(node);
            node.children?.forEach(visit);
        };
        visit(root);
        return all;
    };
    const pill = () => nodes().find((node) => node.props?.class?.includes('activity-pill'));
    const summary = () => nodes().find((node) => node.props?.class?.includes('process-summary'));
    assert.equal(summary().props['aria-expanded'], true, '执行中默认展开动作列表');
    assert.ok(pill(), '默认显示动作列表');
    assert.equal(pill().props['aria-expanded'], false, '执行中详情应保持收起，避免完成后瞬间收起');
    assert.ok(
        nodes().some((node) => node.props?.class?.includes('activity-loading')),
        '执行中卡片右侧应显示 loading'
    );
    pill().props.onClick();
    await nextTick();
    assert.equal(pill().props['aria-expanded'], true, '执行中也应允许手动展开');
    props.blocks[0].activity = { ...activity, status: 'warning', durationMs: 24, warning: '数据不完整' };
    await nextTick();
    assert.equal(pill().props['aria-expanded'], true, '完成后应保留手动展开状态');
    assert.ok(!nodes().some((node) => node.props?.class?.includes('activity-loading')), '完成后应停止 loading');
    pill().props.onClick();
    await nextTick();
    assert.equal(pill().props['aria-expanded'], false);
    props.blocks.push({ type: 'analysis_activity', activity: { ...activity, id: 'query2' } });
    await nextTick();
    assert.ok(
        nodes()
            .filter((node) => node.props?.class?.includes('activity-pill'))
            .every((node) => node.props['aria-expanded'] === false)
    );
    props.blocks[1].activity = { ...activity, id: 'query2', status: 'warning', durationMs: 52 };
    await nextTick();
    assert.ok(
        nodes()
            .filter((node) => node.props?.class?.includes('activity-pill'))
            .every((node) => node.props['aria-expanded'] === false),
        '警告完成应保持收起'
    );
    summary().props.onClick();
    await nextTick();
    assert.equal(pill(), undefined, '执行中允许手动收起列表');
    props.blocks.push({ type: 'analysis_activity', activity: { ...activity, id: 'query3' } });
    await nextTick();
    assert.equal(summary().props['aria-expanded'], false, '新增步骤不覆盖手动收起');
    summary().props.onClick();
    await nextTick();
    props.blocks.push({ type: 'text', analysis: { kind: 'answer' } });
    await nextTick();
    assert.equal(summary().props['aria-expanded'], true, '结果到达但生成未结束时保持展开');
    props.isStreaming = false;
    await nextTick();
    assert.equal(summary().props['aria-expanded'], false, '分析结束自动收起');
    assert.equal(pill(), undefined);
    summary().props.onClick();
    await nextTick();
    assert.ok(pill(), '完成后允许手动查看步骤');
    props.isStreaming = true;
    await nextTick();
    assert.equal(summary().props['aria-expanded'], true, '重新开始分析默认展开');
    app.unmount();
    props.isStreaming = false;
    app = renderer.createApp({ render: () => h(Component, props) });
    app.mount(root);
    assert.equal(summary().props['aria-expanded'], false, '历史已完成消息默认收起');
    app.unmount();
    const { default: ChatMessage } = await import(chatModulePath.href);
    const message = reactive({ id: 'message', role: 'assistant', blocks: [], content: '', timestamp: 0 });
    const chatProps = reactive({ msg: message, isStreaming: true });
    const sent = [];
    let finishSending;
    globalThis.__suggestionTestChat = reactive({
        generations: { test: { id: 'test', messageId: 'message', status: 'running' } },
        activeConversation: { messages: [message] },
        isLoading: false,
        sendMessage: (text) => {
            sent.push(text);
            return new Promise((resolve) => {
                finishSending = resolve;
            });
        },
    });
    app = renderer.createApp({ render: () => h(ChatMessage, chatProps) });
    const chatRoot = { children: [] };
    app.mount(chatRoot);
    const hasProcess = (node = chatRoot) => node.props?.class === 'process-probe' || !!node.children?.some((child) => hasProcess(child));
    assert.equal(hasProcess(), false, '无事件时还没有过程卡片');
    message.blocks.push({ type: 'log', title: '分析步骤 1', content: '正在评估下一步行动...' });
    await nextTick();
    assert.equal(hasProcess(), true, '首条日志到达就应挂载过程卡片，不必等工具执行完');
    const findSuggestion = (node = chatRoot) => (node.props?.class === 'suggestion-probe' ? node : node.children?.map((child) => findSuggestion(child)).find(Boolean));
    message.blocks.push({ type: 'suggestions', version: 1, items: [{ id: '1', text: '查看区域趋势' }] });
    await nextTick();
    assert.equal(findSuggestion(), undefined, '生成中隐藏推荐');
    globalThis.__suggestionTestChat.generations.test.status = 'completed';
    chatProps.isStreaming = false;
    await nextTick();
    assert.ok(findSuggestion(), '回答完成后动态渲染推荐组件');
    const click = findSuggestion().props.onClick;
    click();
    click();
    await nextTick();
    assert.deepEqual(sent, ['查看区域趋势'], '点击直接发送并阻止重复提交');
    assert.equal(findSuggestion().props.disabled, true);
    finishSending(false);
    await nextTick();
    await nextTick();
    assert.equal(findSuggestion().props.disabled, false, '发送失败后允许重试');
    globalThis.__suggestionTestChat.activeConversation.messages.push({ id: 'next', role: 'user' });
    await nextTick();
    assert.equal(findSuggestion(), undefined, '下一轮开始后隐藏历史推荐');
    console.log('PASS: running → warning without expansion flicker, right-side loading, manual expansion and progress before tools');
    console.log('PASS: suggestions renderer, completion visibility, direct sending, duplicate prevention and failed-send recovery');
} finally {
    delete globalThis.__suggestionTestChat;
    app?.unmount();
    await unlink(modulePath);
    await unlink(chatModulePath);
}
