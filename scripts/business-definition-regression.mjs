import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { BusinessDefinitionRepository, validateDefinition, positiveInteger, DefinitionError } = require('../packages/database/dist/index.js');
let checks = 0;
async function check(name, fn) {
    await fn();
    checks++;
    console.log(`PASS ${name}`);
}
const id = '00000000-0000-4000-8000-000000000001',
    cid = '00000000-0000-4000-8000-000000000002';
const content = { type: 'metric', name: ' 激活率 ', description: '七天成熟用户', relatedFields: ['users.signup_at'], metric: { timezone: 'UTC' } };
function harness() {
    let state = {
        definitions: [],
        revisions: [],
        candidates: [],
        generation: { status: 'completed', user_id: 1, datasource_id: 1, request_message_id: 'message' },
        fields: [{ table_name: 'users', column_name: 'signup_at' }],
    };
    const statements = [];
    const query = async (sql, p = []) => {
        statements.push(sql);
        if (sql.includes('FROM data_source d')) return p[0] === 1 && (p[1] === 1 || (!sql.includes('AND\n          d.created_by=?') && p[1] === 2)) ? [{ id: 1 }] : [];
        if (sql.includes('information_schema.columns')) return state.fields;
        if (sql.startsWith('SELECT d.id')) {
            let rows = state.definitions.flatMap((d) =>
                state.revisions.filter((r) => r.definition_id === d.id).map((r) => ({ ...d, ...r, current_status: d.status, updated_at: r.created_at }))
            );
            if (sql.includes('WHERE d.id=?')) rows = rows.filter((r) => r.id === p[0]);
            else rows = rows.filter((r) => r.datasource_id === p[0]);
            if (sql.includes("d.status='active'")) rows = rows.filter((r) => r.current_status === 'active');
            if (sql.includes('r.version=d.version')) rows = rows.filter((r) => r.version === state.definitions.find((d) => d.id === r.id).version);
            if (sql.includes('r.version=?')) rows = rows.filter((r) => r.version === p[1]);
            return structuredClone(rows);
        }
        if (sql.startsWith('SELECT version,status')) return state.definitions.filter((d) => d.id === p[0] && d.datasource_id === p[1]);
        if (sql.startsWith('INSERT INTO business_definition(')) {
            if (state.definitions.some((d) => d.normalized_name === p[2] && d.status === 'active')) throw Object.assign(new Error('duplicate'), { code: '23505' });
            state.definitions.push({ id, datasource_id: p[0], version: 1, status: p[1], normalized_name: p[2], created_by: p[3], created_at: 'now' });
            return [{ id }];
        }
        if (sql.startsWith('UPDATE business_definition SET')) {
            Object.assign(
                state.definitions.find((d) => d.id === p[3]),
                { version: p[0], status: p[1], normalized_name: p[2] }
            );
            return [];
        }
        if (sql.startsWith('INSERT INTO business_definition_revision')) {
            state.revisions.push({
                definition_id: p[0],
                version: p[1],
                content: JSON.parse(p[2]),
                status: p[3],
                source: p[4],
                source_message_id: p[5],
                confirmed_by: p[6],
                created_at: 'now',
            });
            return [];
        }
        if (sql.startsWith('SELECT c.*'))
            return state.generation.status === 'completed'
                ? structuredClone(
                      state.candidates.filter((c) => c.user_id === p[1] && (sql.includes('c.id=?') ? c.id === p[0] : c.datasource_id === p[0] && c.status === 'pending'))
                  )
                : [];
        if (sql.startsWith('UPDATE business_definition_candidate')) {
            Object.assign(
                state.candidates.find((c) => c.id === p[3]),
                { status: p[0], version: state.candidates[0].version + 1, result_definition_id: p[1], result_version: p[2] }
            );
            return [];
        }
        if (sql.startsWith('SELECT request_message_id'))
            return ['running', 'starting'].includes(state.generation.status) && p[1] === 1 && p[2] === 1 && p[3] === 'writer' ? [state.generation] : [];
        if (sql.startsWith('SELECT COUNT(*)')) return [{ count: state.candidates.length }];
        if (sql.startsWith('INSERT INTO business_definition_candidate')) {
            state.candidates.push({
                id: cid,
                datasource_id: p[0],
                user_id: p[1],
                generation_id: p[2],
                source_message_id: p[3],
                definition_id: p[4],
                expected_version: p[5],
                content: JSON.parse(p[6]),
                version: 1,
                status: 'pending',
            });
            return [{ id: cid }];
        }
        throw new Error(`Unhandled query: ${sql}`);
    };
    const db = {
        withTransaction: async (fn) => {
            const before = structuredClone(state);
            try {
                return await fn({ query: async (sql, p) => [await query(sql, p)] });
            } catch (e) {
                state = before;
                throw e;
            }
        },
    };
    return { repo: new BusinessDefinitionRepository(db), state: () => state, statements };
}
const fails = (fn, status) => assert.rejects(fn, (e) => e instanceof DefinitionError && e.status === status);
await check('strict content whitelist, type-specific fields and integer parsing', async () => {
    assert.equal(validateDefinition(content).name, '激活率');
    for (const value of [
        { ...content, confirmedBy: 1 },
        { ...content, name: ' ' },
        { ...content, type: 'term', metric: {} },
        { ...content, metric: { sql: 'DROP' } },
    ])
        assert.throws(() => validateDefinition(value), DefinitionError);
    for (const value of [undefined, null, '', 0, -1, '1.5', true]) assert.throws(() => positiveInteger(value), DefinitionError);
});
await check('create, patch, immutable history, snapshot refresh and soft deletion', async () => {
    const h = harness(),
        r = h.repo;
    const a = await r.create(1, 1, content);
    assert.equal(a.version, 1);
    const before = await r.snapshot(1, 1);
    await r.update(1, id, 1, { description: '新的成熟窗口' });
    assert.equal((await r.snapshot(1, 1))[0].version, 2);
    assert.equal(before[0].version, 1);
    assert.equal((await r.get(1, id, 1)).description, '七天成熟用户');
    await fails(() => r.update(1, id, 1, { description: 'stale' }), 409);
    await r.update(1, id, 2, {}, true);
    assert.deepEqual(await r.snapshot(1, 1), []);
    assert.equal((await r.get(1, id, 1)).status, 'deleted');
    assert.equal(h.state().revisions.length, 3);
});
await check('read access does not imply write access; historical records still authorize', async () => {
    const { repo: r } = harness();
    await r.create(1, 1, content);
    assert.equal((await r.get(2, id)).id, id);
    await fails(() => r.get(3, id, 1), 404);
    await fails(() => r.create(2, 1, content), 404);
    await fails(() => r.list(3, 1), 404);
});
await check('unknown references reject writes and drift marks existing definitions', async () => {
    const h = harness();
    await fails(() => h.repo.create(1, 1, { ...content, relatedFields: ['other.secret'] }), 400);
    await h.repo.create(1, 1, content);
    h.state().fields = [];
    assert.equal((await h.repo.snapshot(1, 1))[0].needsReview, true);
});
await check('normalized name conflicts are explicit and transaction rollback leaves no revision', async () => {
    const h = harness();
    await h.repo.create(1, 1, content);
    await fails(() => h.repo.create(1, 1, content), 409);
    assert.equal(h.state().revisions.length, 1);
});
await check('candidate draft excluded until success; cancellation blocks proposals', async () => {
    const h = harness();
    h.state().generation.status = 'running';
    await h.repo.propose(1, 1, 'g', 'writer', { content });
    assert.deepEqual(await h.repo.candidates(1, 1), []);
    assert.deepEqual(await h.repo.snapshot(1, 1), []);
    h.state().generation.status = 'cancelled';
    await fails(() => h.repo.propose(1, 1, 'g', 'writer', { content }), 409);
    await fails(() => h.repo.decide(1, cid, 1, true), 404);
    h.state().generation.status = 'completed';
    assert.equal((await h.repo.candidates(1, 1)).length, 1);
});
await check('confirmation is explicit and idempotent; only owner sees candidate', async () => {
    const h = harness();
    h.state().generation.status = 'running';
    await h.repo.propose(1, 1, 'g', 'writer', { content });
    h.state().generation.status = 'completed';
    await fails(() => h.repo.decide(2, cid, 1, true), 404);
    assert.deepEqual(await h.repo.snapshot(1, 1), []);
    const result = await h.repo.decide(1, cid, 1, true);
    assert.equal(result.status, 'accepted');
    assert.deepEqual(await h.repo.decide(1, cid, 1, true), result);
    assert.equal(h.state().revisions.length, 1);
    assert.equal((await h.repo.snapshot(1, 1))[0].source, 'conversation');
    await fails(() => h.repo.decide(1, cid, 1, false), 409);
});
await check('candidate target conflict rolls back acceptance and preserves pending state', async () => {
    const h = harness();
    await h.repo.create(1, 1, content);
    h.state().candidates.push({ id: cid, user_id: 1, datasource_id: 1, version: 1, status: 'pending', content, definition_id: id, expected_version: 1, source_message_id: 'm' });
    await h.repo.update(1, id, 1, { description: 'new' });
    await fails(() => h.repo.decide(1, cid, 1, true), 409);
    assert.equal(h.state().candidates[0].status, 'pending');
    assert.equal(h.state().revisions.length, 2);
});
await check('reject is idempotent and does not create knowledge', async () => {
    const h = harness();
    h.state().generation.status = 'running';
    await h.repo.propose(1, 1, 'g', 'writer', { content });
    h.state().generation.status = 'completed';
    await h.repo.decide(1, cid, 1, false);
    await h.repo.decide(1, cid, 1, false);
    assert.deepEqual(await h.repo.snapshot(1, 1), []);
});
await check('type changes discard old type payload', async () => {
    const h = harness();
    await h.repo.create(1, 1, content);
    const result = await h.repo.update(1, id, 1, { type: 'term' });
    assert.equal(result.metric, undefined);
});
console.log(`${checks} business definition mock groups passed (no external services)`);
