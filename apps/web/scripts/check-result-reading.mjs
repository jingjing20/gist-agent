import assert from 'node:assert/strict';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { parse, compileScript } from 'vue/compiler-sfc';
import ts from 'typescript';
import { createRenderer, h, reactive, nextTick } from 'vue';
const temporary = [];
async function compile(name, source) {
    const path = new URL(`./.result-${name}.mjs`, import.meta.url);
    temporary.push(path);
    await writeFile(path, ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText);
    return path;
}
const scrollModule = await compile('scroll', await readFile(new URL('../src/utils/scroll-follow.ts', import.meta.url), 'utf8'));
const renderer = createRenderer({
    createElement: (tag) => {
        const node = { tag, children: [], props: {}, scrollHeight: 1000, clientHeight: 500 };
        let top = 0;
        Object.defineProperty(node, 'scrollTop', {
            get: () => top,
            set: (value) => {
                top = Math.max(0, Math.min(value, node.scrollHeight - node.clientHeight));
            },
        });
        return node;
    },
    createText: (text) => ({ text }),
    createComment: () => ({}),
    insert: (node, parent, anchor) => {
        if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1);
        node.parent = parent;
        const i = parent.children.indexOf(anchor);
        parent.children.splice(i < 0 ? parent.children.length : i, 0, node);
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
const observers = [];
globalThis.ResizeObserver = class {
    constructor(callback) {
        this.callback = callback;
        observers.push(this);
    }
    observe() {}
    disconnect() {}
};
const root = { children: [] };
function nodes() {
    const all = [];
    const visit = (node) => {
        all.push(node);
        node.children?.forEach(visit);
    };
    visit(root);
    return all;
}
const find = (name) =>
    nodes().find((node) =>
        String(node.props?.class || '')
            .split(' ')
            .includes(name)
    );
const flush = async () => {
    await nextTick();
    await nextTick();
};
let app;
try {
    const scroll = await import(scrollModule.href);
    assert.equal(scroll.isAtBottom({ scrollHeight: 1000, scrollTop: 500, clientHeight: 500 }), true);
    assert.equal(scroll.isAtBottom({ scrollHeight: 1000, scrollTop: 480, clientHeight: 500 }), false);
    assert.equal(scroll.shouldPauseFollowing(400, 500, false, true), false, '布局收缩引起的滚动不应当作用户操作');
    const source = (await readFile(new URL('../src/components/ChatDetail.vue', import.meta.url), 'utf8'))
        .replace("import { useChatStore } from '../stores/chat';", 'const useChatStore = () => globalThis.__readingChat;')
        .replace("from '../utils/scroll-follow'", "from './.result-scroll.mjs'")
        .replace(/import (\w+) from '[^']+\.vue';/g, 'const $1 = { render: () => null };');
    const descriptor = parse(source).descriptor;
    const module = await compile('detail', compileScript(descriptor, { id: 'result-reading-test', inlineTemplate: true }).content);
    globalThis.__readingChat = reactive({ activeConversationId: 'c', activeConversation: { title: '分析', messages: [{ id: 'a', role: 'assistant' }] }, isLoading: true });
    const { default: Detail } = await import(module.href);
    app = renderer.createApp({ render: () => h(Detail) });
    app.mount(root);
    await flush();
    const list = find('message-list');
    assert.equal(list.scrollTop, 500, '新回答默认自动到达底部');
    list.scrollHeight = 1200;
    observers[0].callback();
    await flush();
    assert.equal(list.scrollTop, 700, '内容实际增高继续自动跟随');
    list.props.onWheelPassive();
    list.scrollTop = 350;
    list.props.onScroll();
    await flush();
    list.scrollHeight = 1400;
    observers[0].callback();
    await flush();
    assert.equal(list.scrollTop, 350, '用户上滚后内容增高不得移动阅读位置');
    assert.ok(find('latest-dots'), '生成中有下方内容时显示三点');
    globalThis.__readingChat.isLoading = false;
    await flush();
    assert.equal(find('latest-dots'), undefined);
    assert.ok(find('latest-button'), '结束后仍保留跳到底部按钮');
    find('latest-button').props.onClick();
    await flush();
    assert.equal(list.scrollTop, 900);
    assert.equal(find('latest-button'), undefined, '底部隐藏按钮');
    list.scrollHeight = 1500;
    observers[0].callback();
    await flush();
    assert.equal(list.scrollTop, 1000, '点击按钮恢复跟随');
    list.props.onWheelPassive();
    list.scrollTop = 300;
    list.props.onScroll();
    await flush();
    list.props.onWheelPassive();
    list.scrollTop = 1000;
    list.props.onScroll();
    await flush();
    list.scrollHeight = 1600;
    observers[0].callback();
    await flush();
    assert.equal(list.scrollTop, 1100, '手动回到底部恢复跟随');
    list.props['onResultPanelOpen']();
    list.scrollHeight = 1800;
    observers[0].callback();
    await flush();
    assert.equal(list.scrollTop, 1100, '打开结果面板时保留阅读位置');
    list.props['onResultPanelClose']();
    list.scrollHeight = 1900;
    observers[0].callback();
    await flush();
    assert.equal(list.scrollTop, 1100, '关闭结果面板不会跳到新增内容底部');
    globalThis.__readingChat.activeConversation.messages.push({ id: 'u2', role: 'user' }, { id: 'a2', role: 'assistant' });
    await flush();
    assert.equal(list.scrollTop, 1400, '用户发送新问题，即使助手占位同批出现也恢复跟随');
    app.unmount();

    // Render the actual analysis component: empty metadata has no flex item,
    // but partial outcomes and memory candidates remain visible.
    const analysisSource = (await readFile(new URL('../src/components/blocks/AnalysisBlock.vue', import.meta.url), 'utf8'))
        .replace("import { apiFetch } from '../../api';", 'const apiFetch = async () => ({ ok: true, json: async () => globalThis.__memoryCandidates });')
        .replace(/import \{ use(Chat|DataSource|Auth)Store \} from '[^']+';/g, (_, name) => `const use${name}Store = () => globalThis.__analysisStores.${name};`)
        .replace(/import (\w+) from '[^']+\.vue';/g, 'const $1 = { render: () => null };');
    const analysisModule = await compile('analysis', compileScript(parse(analysisSource).descriptor, { id: 'empty-analysis-test', inlineTemplate: true }).content);
    globalThis.__analysisStores = { Chat: {}, DataSource: { list: [] }, Auth: { user: { id: 1 } } };
    globalThis.__memoryCandidates = [];
    const props = reactive({
        messageId: 'a',
        isStreaming: false,
        analysis: { state: { datasourceId: 1, conversationId: 'c' }, snapshot: { requestMessageId: 'u' }, outcome: { kind: 'response', status: 'complete', blocks: [] } },
    });
    const { default: Analysis } = await import(analysisModule.href);
    app = renderer.createApp({ render: () => h(Analysis, props) });
    app.mount(root);
    await flush();
    assert.equal(find('analysis-result'), undefined, '只有元数据的分析块不产生空白容器');
    props.analysis.outcome = { kind: 'response', status: 'partial', reason: '缺少八月数据', blocks: [] };
    await flush();
    assert.ok(find('partial-reason'), '空内容的部分结果仍直接显示原因');
    props.analysis.outcome = { kind: 'response', status: 'complete', blocks: [] };
    globalThis.__analysisStores.DataSource.list = [{ id: 1, created_by: 1, name: '测试数据源' }];
    globalThis.__memoryCandidates = [{ id: 'm', sourceMessageId: 'u', datasourceId: 1, content: { name: '收入定义' } }];
    props.analysis = { ...props.analysis };
    await flush();
    await flush();
    assert.ok(find('analysis-result'), '待保存记忆仍能展示在元数据块中');
    app.unmount();
    const artifactSource = (await readFile(new URL('../src/components/blocks/ArtifactResult.vue', import.meta.url), 'utf8'))
        .replace('<script setup lang="ts">', '<script setup lang="ts">\nimport { h as testH } from "vue";')
        .replace(/import \{ ([^}]+) \} from '[^']+\/ui\/(button|dialog)';/g, (_, names) =>
            names
                .split(',')
                .map((name) => {
                    name = name.trim();
                    if (name === 'Button') return 'const Button = { inheritAttrs: false, render() { return testH("button", this.$attrs, this.$slots.default?.()); } };';
                    if (name === 'DialogContent') return 'const DialogContent = { render: () => null };';
                    return `const ${name} = { render() { return testH("div", {}, this.$slots.default?.()); } };`;
                })
                .join('\n')
        )
        .replace(
            /import (\w+) from '[^']+\.vue';/g,
            (_, name) => `const ${name} = { inheritAttrs: false, render() { return testH("div", { class: "${name}-probe", ...this.$attrs }, this.$slots.actions?.()); } };`
        );
    const artifactModule = await compile('artifact', compileScript(parse(artifactSource).descriptor, { id: 'artifact-result-test', inlineTemplate: true }).content);
    const { default: Artifact } = await import(artifactModule.href);
    const artifactProps = reactive({
        conversationId: 'c',
        block: { type: 'chart', queryArtifactId: 'q', chartData: { chartType: 'line', title: '地区收入', xAxis: ['八月', '七月'], series: [{ name: '收入', data: [30, 20] }] } },
    });
    app = renderer.createApp({ render: () => h(Artifact, artifactProps) });
    app.mount(root);
    await flush();
    assert.equal(find('TableBlock-probe'), undefined, '图表默认不重复附上数据表');
    const text = (node) => (node.text || '') + (node.children || []).map(text).join('');
    assert.equal(
        nodes().find((node) => node.tag === 'button' && text(node).includes('查看数据')),
        undefined,
        '图表不提供查看数据操作'
    );
    const chart = find('ChartBlock-probe');
    const actions = nodes().filter((node) => node.tag === 'button');
    assert.ok(
        actions.some((node) => node.props['aria-label'] === '查看依据'),
        '保留依据入口'
    );
    assert.ok(
        actions.some((node) => node.props['aria-label'] === '放大查看'),
        '保留放大入口'
    );
    assert.ok(chart.children.length, '操作通过组件内部插槽展示');
    artifactProps.block = { type: 'table', queryArtifactId: 'q', title: '排名' };
    await flush();
    assert.equal(find('AnalysisArtifactTable-probe').props.artifactId, 'q');
    assert.equal(find('AnalysisArtifactTable-probe').props.conversationId, 'c', '明细表保留原查询与会话关联');
    app.unmount();

    const pendingEvidence = [];
    globalThis.__evidenceFetch = (url) => new Promise((resolve) => pendingEvidence.push({ url, resolve }));
    const evidenceSource = (await readFile(new URL('../src/components/blocks/QueryEvidence.vue', import.meta.url), 'utf8'))
        .replace("import { apiFetch } from '../../api';", 'const apiFetch = url => globalThis.__evidenceFetch(url);')
        .replace(/import \{ Button \} from '[^']+';/, 'const Button = { render: () => null };')
        .replace(/import (\w+) from '[^']+\.vue';/g, 'const $1 = { render: () => null };');
    const evidenceModule = await compile('evidence', compileScript(parse(evidenceSource).descriptor, { id: 'query-evidence-test', inlineTemplate: true }).content);
    const { default: Evidence } = await import(evidenceModule.href);
    const evidenceProps = reactive({ conversationId: 'c', artifactId: 'q1' });
    app = renderer.createApp({ render: () => h(Evidence, evidenceProps) });
    app.mount(root);
    await flush();
    assert.match(pendingEvidence[0].url, /q1\?conversationId=c$/);
    evidenceProps.artifactId = 'q2';
    await flush();
    const evidence = (title) => ({ title, purpose: title, createdAt: '2026-10-09', returnedRowCount: 10, executedSql: 'SELECT 1', originalSql: 'SELECT 1' });
    pendingEvidence[1].resolve({ ok: true, json: async () => evidence('当前依据') });
    await flush();
    await flush();
    pendingEvidence[0].resolve({ ok: true, json: async () => evidence('过期依据') });
    await flush();
    await flush();
    assert.ok(text(root).includes('当前依据'));
    assert.ok(!text(root).includes('过期依据'), '延迟返回的旧证据不得覆盖当前结果');
    console.log('PASS result tools: embedded chart actions, no chart data action, detail table artifact linkage and evidence request race (mock APIs)');
    console.log('PASS result reading: follow/pause/resume, generating/completed button, modal position, empty metadata, partial result and memory actions (no browser/services)');
} finally {
    app?.unmount();
    await Promise.all(temporary.map((path) => unlink(path).catch(() => {})));
    delete globalThis.__readingChat;
    delete globalThis.__analysisStores;
    delete globalThis.__memoryCandidates;
    delete globalThis.__evidenceFetch;
}
