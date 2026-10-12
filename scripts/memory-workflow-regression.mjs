import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { prepareConversationMemory } = require('../apps/worker/dist/analysis/prepare-conversation-memory.js');
const { MemoryError, MemoryReviewRequired } = require('../packages/database/dist/index.js');
const input = { userId: 1, datasourceId: 2, generationId: 'g', writerToken: 'w', requestMessageId: 'u' };
let saved = [],
    proposed = [];
const repository = {
    rememberFromConversation: async (...args) => {
        saved.push(args);
        return { ...args[3], id: 'm', version: 1, status: 'active' };
    },
    propose: async (...args) => {
        proposed.push(args);
        return { candidateId: 'c' };
    },
};
const run = (message, repo = repository) => prepareConversationMemory(repo, { ...input, message });
assert.equal(await run('分析上个月销售额'), null);
assert.equal(saved.length + proposed.length, 0);
const direct = await run('记住：有效订单不包含退款订单');
assert.equal(direct.status, 'saved');
assert.equal(direct.memory.description, '有效订单不包含退款订单');
assert.match(direct.message, /失败或取消不会撤销/);
const mixed = await run('记住：有效订单不包含退款订单。另外帮我看看上个月的销售额');
assert.equal(mixed.status, 'pending');
assert.equal(saved.length, 1);
assert.equal(proposed[0][4].content.description, '有效订单不包含退款订单');
assert.equal((await run('记住：退款订单不再排除')).status, 'pending');
const beforeAmbiguous = proposed.length;
assert.equal((await run('记住：刚才那个口径')).status, 'review_required');
assert.equal(proposed.length, beforeAmbiguous, '不能把未解析的指代直接生成候选');
assert.equal(
    (
        await run('记住：有效订单不包含退款订单', {
            ...repository,
            rememberFromConversation: async () => {
                throw new MemoryReviewRequired();
            },
        })
    ).status,
    'pending'
);
assert.equal(
    (
        await run('记住：有效订单不包含退款订单', {
            ...repository,
            rememberFromConversation: async () => {
                throw new MemoryError(404, '数据源或记忆不可访问');
            },
        })
    ).status,
    'not_saved'
);
assert.equal(
    (
        await run('记住：有效订单不包含退款订单', {
            ...repository,
            rememberFromConversation: async () => ({ id: 'm', status: 'deleted' }),
        })
    ).status,
    'not_saved'
);
await assert.rejects(
    () =>
        run('记住：有效订单不包含退款订单', {
            ...repository,
            rememberFromConversation: async () => {
                throw new Error('database unavailable');
            },
        }),
    /database unavailable/
);
console.log(
    'PASS memory workflow: direct-save receipt, mixed-request boundary, modification review, ambiguous reference, duplicate review, permission failure and deleted retry (mock repository)'
);
