// Run after pnpm --filter @gist/api... build
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { GenerationService } = require('../apps/api/dist/chat/generation.service.js');

function openStream() {
    const request = new EventEmitter();
    const writes = [];
    const response = {
        writableEnded: false,
        status() {
            return this;
        },
        set() {
            return this;
        },
        flushHeaders() {},
        write(data) {
            writes.push(data);
        },
        end() {
            this.writableEnded = true;
        },
    };
    let resolveRead;
    let rejectRead;
    const client = {
        xread() {
            return new Promise((resolve, reject) => {
                resolveRead = resolve;
                rejectRead = reject;
            });
        },
        disconnect() {
            rejectRead(new Error('Connection is closed.'));
        },
    };
    // Exercise the real stream method without opening the service's shared Redis connection.
    const service = Object.create(GenerationService.prototype);
    service.redis = { duplicate: () => client };
    service.prefix = 'test';
    const completion = service.stream(1, '0-0', request, response);
    return { request, response, writes, client, completion, resolveRead: (value) => resolveRead(value), rejectRead: (error) => rejectRead(error) };
}

test('closing a page during a blocking Redis read ends the stream normally', async () => {
    const stream = openStream();
    stream.request.emit('close');
    await stream.completion;
    assert.equal(stream.response.writableEnded, true);
    assert.equal(stream.request.listenerCount('close'), 0);
});

test('a closed Redis connection while the page is connected still rejects', async () => {
    const stream = openStream();
    const error = new Error('Connection is closed.');
    stream.rejectRead(error);
    await assert.rejects(stream.completion, (actual) => actual === error);
    assert.equal(stream.response.writableEnded, true);
    assert.equal(stream.request.listenerCount('close'), 0);
});

test('unrelated Redis errors are preserved even if the page closes', async () => {
    const stream = openStream();
    const error = new Error('WRONGTYPE Operation against a key holding the wrong kind of value');
    stream.rejectRead(error);
    stream.request.emit('close');
    await assert.rejects(stream.completion, (actual) => actual === error);
});

test('a read completing as the page closes does not write to the closed stream', async () => {
    const stream = openStream();
    stream.resolveRead([['test:{1}:user', [['1-0', ['payload', '{"type":"done"}']]]]]);
    stream.request.emit('close');
    await stream.completion;
    assert.deepEqual(stream.writes, []);
});

test('a heartbeat completing as the page closes does not write to the closed stream', async () => {
    const stream = openStream();
    stream.resolveRead(null);
    stream.request.emit('close');
    await stream.completion;
    assert.deepEqual(stream.writes, []);
});
