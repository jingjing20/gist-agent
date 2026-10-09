import assert from 'node:assert/strict';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { parse, compileScript } from 'vue/compiler-sfc';
import ts from 'typescript';
import { createRenderer, h, reactive, nextTick } from 'vue';
import { createPinia, setActivePinia } from 'pinia';

const source = (await readFile(new URL('../src/components/blocks/MarkdownBlock.vue', import.meta.url), 'utf8')).replace(
    "import { textPlaybackKey } from '../../utils/text-playback';",
    'const textPlaybackKey = Symbol.for("test-text-playback");'
);
const { descriptor } = parse(source);
const compiled = compileScript(descriptor, { id: 'streaming-test', inlineTemplate: true });
const modulePath = new URL('./.streaming-component.mjs', import.meta.url);
await writeFile(modulePath, ts.transpileModule(compiled.content, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText);
const storePath = new URL('./.streaming-store.mjs', import.meta.url);
const chatPath = new URL('./.streaming-message.mjs', import.meta.url);
const chatSource = (await readFile(new URL('../src/components/ChatMessageItem.vue', import.meta.url), 'utf8'))
    .replace("import { textPlaybackKey } from '../utils/text-playback';", 'const textPlaybackKey = Symbol.for("test-text-playback");')
    .replace("import { useChatStore } from '../stores/chat';", 'const useChatStore = () => globalThis.__streamingChat;')
    .replace(/import (\w+) from '[^']+\.vue';/g, (match, name) => {
        if (name === 'MarkdownBlock') return "import MarkdownBlock from './.streaming-component.mjs';";
        if (name === 'AnalysisBlock')
            return 'const AnalysisBlock = { props: ["analysis", "isStreaming"], render() { return testH("section", this.analysis.outcome.blocks.map(block => testH(MarkdownBlock, { content: block.content, isStreaming: this.isStreaming }))); } };';
        if (name === 'SuggestionBlock') return 'const SuggestionBlock = { render: () => testH("button", { "data-suggestions": true }) };';
        return `const ${name} = { render: () => null };`;
    });
const chatDescriptor = parse(chatSource.replace('<script setup lang="ts">', '<script setup lang="ts">\nimport { h as testH } from "vue";')).descriptor;
await writeFile(
    chatPath,
    ts.transpileModule(compileScript(chatDescriptor, { id: 'suggestion-drain-test', inlineTemplate: true }).content, {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    }).outputText
);
const storeSource = (await readFile(new URL('../src/stores/chat.ts', import.meta.url), 'utf8'))
    .replace("import { useRouter } from 'vue-router';", 'const useRouter = () => ({ replace: async () => {} });')
    .replace("import { apiFetch } from '../api';", 'const apiFetch = async () => ({ json: async () => [] });')
    .replace("import { useToastStore } from './toast';", 'const useToastStore = () => ({ error() {} });')
    .replace('        conversations,', '        applyEvent,\n        conversations,');
await writeFile(storePath, ts.transpileModule(storeSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText);
const timers = new Map();
let timerId = 0;
const originalTimeout = globalThis.setTimeout;
const originalClear = globalThis.clearTimeout;
globalThis.setTimeout = (callback) => {
    timers.set(++timerId, callback);
    return timerId;
};
globalThis.clearTimeout = (id) => timers.delete(id);
const renderer = createRenderer({
    createElement: () => ({ children: [], html: '' }),
    createText: (text) => ({ text }),
    createComment: () => ({}),
    insert: (node, parent) => {
        node.parent = parent;
        parent.children.push(node);
    },
    remove: (node) => {
        if (node.parent) node.parent.children = node.parent.children.filter((item) => item !== node);
    },
    setText: (node, text) => {
        node.text = text;
    },
    setElementText: () => {},
    parentNode: (node) => node.parent,
    nextSibling: () => null,
    patchProp: (node, key, previous, value) => {
        if (key === 'innerHTML') node.html = value;
        else {
            node.props ||= {};
            node.props[key] = value;
        }
    },
});
let app;
try {
    const { default: Component } = await import(modulePath.href);
    const props = reactive({ content: '这是一段完整的分析结果，应该逐步显示而不是一次出现。', isStreaming: true });
    const root = { children: [] };
    app = renderer.createApp({ render: () => h(Component, props) });
    app.mount(root);
    const html = () => root.children.map((node) => node.html || '').join('');
    const tick = async () => {
        const pending = [...timers.values()];
        timers.clear();
        pending.forEach((callback) => callback());
        await nextTick();
    };
    assert.ok(!html().includes(props.content), '直播结果不应在首帧整段显示');
    await tick();
    assert.ok(html().length > 0 && !html().includes(props.content), '文字应逐步出现');
    props.isStreaming = false;
    await nextTick();
    assert.ok(!html().includes(props.content), 'done 事件不应跳过尚未播放的文字');
    for (let i = 0; i < 200 && timers.size; i++) await tick();
    assert.ok(html().includes(props.content), '播放最终应显示全部内容');
    props.content = '替换后的历史消息';
    await nextTick();
    assert.ok(html().includes(props.content), '历史消息应立即显示');
    app.unmount();
    app = undefined;
    props.isStreaming = true;
    const historyRoot = { children: [] };
    props.isStreaming = false;
    app = renderer.createApp({ render: () => h(Component, props) });
    app.mount(historyRoot);
    assert.ok(
        historyRoot.children.some((node) => node.html?.includes(props.content)),
        '重新打开历史消息不应重播'
    );
    app.unmount();
    app = undefined;
    assert.equal(timers.size, 0, '卸载必须清理播放定时器');
    // Drive the real event reducer with result + done before a Vue render.
    setActivePinia(createPinia());
    const { useChatStore } = await import(storePath.href);
    const store = useChatStore();
    store.conversations.push({ id: 'conversation', messages: [], title: '', createdAt: 0, updatedAt: 0 });
    const event = { generationId: 'generation', conversationId: 'conversation', messageId: 'message', sequence: 1, type: 'text', content: '同批到达的正式结果也应该逐步显示。' };
    store.applyEvent(event);
    store.applyEvent({ ...event, sequence: 2, type: 'done' });
    const message = store.conversations[0].messages[0];
    assert.equal(store.generations.generation.status, 'completed');
    assert.equal(message.animateText, true, '同批 done 不能消除新文字的动画标记');
    const batchRoot = { children: [] };
    app = renderer.createApp({ render: () => h(Component, { content: message.blocks[0].content, isStreaming: !!message.animateText }) });
    app.mount(batchRoot);
    await nextTick();
    await tick();
    assert.ok(
        batchRoot.children.some((node) => node.html),
        '完成事件同批到达时仍应播放'
    );
    assert.ok(!batchRoot.children.some((node) => node.html?.includes(event.content)), '同批完成不能首帧展开全文');
    app.unmount();
    app = undefined;
    assert.equal(timers.size, 0, '播放中卸载也必须清理定时器');
    // Reproduce result + suggestions + done while the real Markdown renderer
    // still has pending characters. Backend completion is not visual completion.
    store.activeConversationId = 'conversation';
    store.conversations[0].messages = [message];
    globalThis.__streamingChat = store;
    message.animateText = true;
    message.blocks.push({ type: 'suggestions', version: 1, items: [{ id: '1', text: '继续分析' }] });
    const { default: ChatMessage } = await import(chatPath.href);
    const integratedRoot = { children: [] };
    app = renderer.createApp({ render: () => h(ChatMessage, { msg: message, isStreaming: store.isLoading }) });
    app.mount(integratedRoot);
    message.animateText = false;
    await nextTick();
    await tick();
    const nodes = (node = integratedRoot) => [node, ...(node.children || []).flatMap((child) => nodes(child))];
    assert.ok(!nodes().some((node) => node.html?.includes(event.content)), '完成事件后结论仍在逐字播放');
    assert.ok(!nodes().some((node) => node.props?.['data-suggestions']), '结论播放完成前不能显示推荐问题');
    for (let i = 0; i < 200 && timers.size; i++) await tick();
    await nextTick();
    assert.ok(
        nodes().some((node) => node.html?.includes(event.content)),
        '结论应完整显示'
    );
    assert.ok(
        nodes().some((node) => node.props?.['data-suggestions']),
        '结论完整显示后才出现推荐问题'
    );
    app.unmount();
    app = undefined;
    message.animateText = true;
    message.blocks = [
        {
            type: 'text',
            analysis: {
                outcome: {
                    kind: 'response',
                    blocks: [
                        { type: 'markdown', content: '短结论' },
                        { type: 'markdown', content: '需要继续展示的较长结论。'.repeat(20) },
                    ],
                },
            },
        },
        { type: 'suggestions', version: 1, items: [{ id: '1', text: '继续分析' }] },
    ];
    const nestedRoot = { children: [] };
    app = renderer.createApp({ render: () => h(ChatMessage, { msg: message, isStreaming: false }) });
    app.mount(nestedRoot);
    message.animateText = false;
    await nextTick();
    for (let i = 0; i < 4; i++) await tick();
    assert.ok(
        nodes(nestedRoot).some((node) => node.html?.includes('短结论')),
        '短文本已经播放完成'
    );
    assert.ok(!nodes(nestedRoot).some((node) => node.props?.['data-suggestions']), '多个嵌套文本块必须全部播放完');
    for (let i = 0; i < 300 && timers.size; i++) await tick();
    await nextTick();
    assert.ok(
        nodes(nestedRoot).some((node) => node.props?.['data-suggestions']),
        '全部嵌套文本播放完成后显示推荐'
    );
    console.log('PASS: streaming text, completion drain, history, same-batch done and cleanup');
    console.log('PASS: recommendations wait for visible completion of plain and nested Markdown');
} finally {
    app?.unmount();
    globalThis.setTimeout = originalTimeout;
    globalThis.clearTimeout = originalClear;
    await unlink(modulePath);
    await unlink(storePath);
    await unlink(chatPath);
    delete globalThis.__streamingChat;
}
