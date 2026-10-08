import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../apps/worker/package.json', import.meta.url));
const { loadWorkspaceEnv, workerConfig } = require('@gist/config');
const Redis = require('ioredis');
loadWorkspaceEnv();
const redis = new Redis(workerConfig().redisUrl, { retryStrategy: () => null, commandTimeout: 2000 });
const fixture = {
    type: 'text',
    content: '中文与引号 " } , sequence: 0',
    analysis: { outcome: { kind: 'response', blocks: [] }, empty: {}, nested: [[], {}, null, false, ['字段']] },
};
try {
    for (const [file, constant, count] of [
        ['apps/worker/src/chat/generation.service.ts', 'PUBLISH_SCRIPT', 3],
        ['apps/api/src/chat/outbox-relay.service.ts', 'PUBLISH_TERMINAL_SCRIPT', 4],
    ]) {
        const source = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
        const lua = source.match(new RegExp('const ' + constant + ' = `([\\s\\S]*?)`;'))?.[1];
        assert.ok(lua);
        const prefix = `{event-json-regression-${randomUUID()}}`;
        const keys = ['sequence', 'generation', 'user', 'dedupe'].slice(0, count).map((key) => `${prefix}:${key}`);
        try {
            await redis.eval(lua, count, ...keys, JSON.stringify(fixture), '10000');
            for (const stream of keys.slice(1, 3)) {
                const entries = await redis.xrange(stream, '-', '+');
                assert.equal(entries.length, 1);
                assert.deepEqual(JSON.parse(entries[0][1][1]), { ...fixture, sequence: 1 }, `${constant} must preserve arrays, objects and scalar values`);
            }
            if (count === 4) {
                await redis.eval(lua, count, ...keys, JSON.stringify(fixture), '10000');
                assert.equal(await redis.xlen(keys[1]), 1, 'terminal retries remain idempotent');
            }
            console.log(`PASS ${constant}: lossless JSON and sequence`);
        } finally {
            await redis.del(...keys);
        }
    }
} finally {
    await redis.quit();
}
