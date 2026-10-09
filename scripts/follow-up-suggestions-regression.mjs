import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../apps/web/package.json', import.meta.url));
const ts = require('typescript');
const source = await readFile(new URL('../apps/worker/src/analysis/follow-up-suggestions.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const exports = {};
new Function('exports', compiled)(exports);
const { parseSuggestions, generateSuggestions } = exports;

assert.deepEqual(parseSuggestions('```json\n["原问题", "  按地区对比  ", "按地区对比", "", null, "a", "b", "c"]\n```', '原问题'), [
    { id: 'suggestion-1', text: '按地区对比' },
    { id: 'suggestion-2', text: 'a' },
    { id: 'suggestion-3', text: 'b' },
]);
assert.deepEqual(parseSuggestions(JSON.stringify(['x'.repeat(161), '']), '原问题'), []);
assert.throws(() => parseSuggestions('{"items":[]}', '原问题'));
assert.throws(() => parseSuggestions('invalid', '原问题'));

const metrics = () => ({ llmCallCount: 0, toolCallCount: 0, sqlCallCount: 0, inputTokensEstimated: 0, outputTokensEstimated: 0 });
const controller = new AbortController();
const measured = metrics();
let requestSignal;
const items = await generateSuggestions({
    question: '比较区域增长',
    context: { result: '华北增长较快' },
    signal: controller.signal,
    metrics: measured,
    llm: {
        streamWithTools: async (messages, tools, options) => {
            assert.equal(tools.length, 0);
            assert.equal(options.reasoningEnabled, false);
            assert.ok(messages[1].content.includes('华北增长较快'));
            requestSignal = options.signal;
            return (async function* () {
                yield { choices: [{ delta: { content: '["拆解华北的' } }] };
                yield { choices: [{ delta: { content: '增长来源"]' } }] };
            })();
        },
    },
});
assert.equal(items[0].text, '拆解华北的增长来源');
assert.equal(measured.llmCallCount, 1);
assert.ok(measured.inputTokensEstimated > 0 && measured.outputTokensEstimated > 0);
assert.ok(requestSignal.aborted, '完成后释放独立请求');
assert.equal(controller.signal.aborted, false, '不取消主分析');

const cancelled = new AbortController();
await assert.rejects(
    generateSuggestions({
        question: '问题',
        context: {},
        signal: cancelled.signal,
        metrics: metrics(),
        llm: {
            streamWithTools: async (messages, tools, options) =>
                new Promise((resolve, reject) => {
                    options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
                    cancelled.abort(new Error('user cancelled'));
                }),
        },
    }),
    /user cancelled/
);

// Trigger the deadline immediately to verify fallback without an eight-second wait.
const originalTimeout = globalThis.setTimeout;
globalThis.setTimeout = (callback) => originalTimeout(callback, 0);
try {
    await assert.rejects(
        generateSuggestions({
            question: '问题',
            context: {},
            signal: controller.signal,
            metrics: metrics(),
            llm: {
                streamWithTools: async (messages, tools, options) =>
                    new Promise((resolve, reject) => {
                        options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
                    }),
            },
        }),
        /推荐问题生成超时/
    );
    assert.equal(controller.signal.aborted, false);
} finally {
    globalThis.setTimeout = originalTimeout;
}
console.log('PASS: suggestions parsing, deduplication, streamed generation, metrics, cancellation and optional timeout');
