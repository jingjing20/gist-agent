import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { TextEventBuffer } = require('../apps/worker/dist/chat/text-event-buffer.js');
const originalTimeout = globalThis.setTimeout;
const originalClear = globalThis.clearTimeout;
const timers = new Map();
let id = 0;
globalThis.setTimeout = (callback, delay) => {
    assert.equal(delay, 16, '文本批处理最长等待一帧');
    timers.set(++id, callback);
    return id;
};
globalThis.clearTimeout = (key) => timers.delete(key);
try {
    const events = [];
    const buffer = new TextEventBuffer((event) => events.push(event));
    for (const content of '连续文本') buffer.send({ type: 'text_chunk', content });
    assert.equal(timers.size, 1, '新增分片不能重新延迟首个分片');
    [...timers.values()][0]();
    assert.deepEqual(events, [{ type: 'text_chunk', content: '连续文本' }]);
    buffer.send({ type: 'text_chunk', content: '图表之前' });
    buffer.send({ type: 'chart', chartArtifactId: 'chart' });
    buffer.send({ type: 'text_chunk', content: '图表之后' });
    buffer.flush();
    assert.deepEqual(
        events.slice(1),
        [
            { type: 'text_chunk', content: '图表之前' },
            { type: 'chart', chartArtifactId: 'chart' },
            { type: 'text_chunk', content: '图表之后' },
        ],
        '合并不能改变文本与图表的事件顺序'
    );
    assert.equal(timers.size, 0, 'drain 清理定时器并保留末尾分片');
    buffer.flush();
    assert.equal(events.length, 4, '重复 drain 不能重发');
    console.log('PASS: bounded text batching, tool ordering, final flush and timer cleanup');
} finally {
    globalThis.setTimeout = originalTimeout;
    globalThis.clearTimeout = originalClear;
}
