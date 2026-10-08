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
    .replace("import { useChatStore } from '../stores/chat';", 'const useChatStore = () => ({ generations: {} });')
    .replace(/import (\w+) from '[^']+\.vue';/g, (match, name) =>
        name === 'AnalysisProcessBlock' ? 'const AnalysisProcessBlock = { render: () => testH("section", { class: "process-probe" }) };' : `const ${name} = { render: () => null };`
    );
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
    app.unmount();
    const { default: ChatMessage } = await import(chatModulePath.href);
    const message = reactive({ id: 'message', role: 'assistant', blocks: [], content: '', timestamp: 0 });
    app = renderer.createApp({ render: () => h(ChatMessage, { msg: message, isStreaming: true }) });
    const chatRoot = { children: [] };
    app.mount(chatRoot);
    const hasProcess = (node = chatRoot) => node.props?.class === 'process-probe' || !!node.children?.some((child) => hasProcess(child));
    assert.equal(hasProcess(), false, '无事件时还没有过程卡片');
    message.blocks.push({ type: 'log', title: '分析步骤 1', content: '正在评估下一步行动...' });
    await nextTick();
    assert.equal(hasProcess(), true, '首条日志到达就应挂载过程卡片，不必等工具执行完');
    console.log('PASS: running → warning without expansion flicker, right-side loading, manual expansion and progress before tools');
} finally {
    app?.unmount();
    await unlink(modulePath);
    await unlink(chatModulePath);
}
