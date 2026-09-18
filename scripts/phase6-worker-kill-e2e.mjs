import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { DatabaseClient } from '@gist/database';
import { loadWorkspaceEnv } from '@gist/config';

loadWorkspaceEnv();
const api = process.env.API_BASE_URL || 'http://127.0.0.1:3000/api';
const database = new DatabaseClient();
const email = `phase6-kill-${randomUUID()}@example.test`;
const children = new Set();

async function request(path, init = {}) {
    const response = await fetch(`${api}${path}`, { ...init, headers: { 'content-type': 'application/json', ...(init.headers || {}) } });
    const body = await response.json();
    if (!response.ok) throw new Error(`${init.method || 'GET'} ${path}: ${response.status} ${JSON.stringify(body)}`);
    return body;
}

function startWorker() {
    const child = spawn(process.execPath, ['apps/worker/dist/main.js'], {
        cwd: new URL('..', import.meta.url).pathname,
        env: {
            ...process.env,
            LLM_PROVIDER: 'mock',
            MOCK_LLM_CHUNK_DELAY_MS: '5000',
            GENERATION_HEARTBEAT_INTERVAL_MS: '250',
            GENERATION_LEASE_TTL_MS: '1000',
            RETENTION_CLEANUP_ENABLED: '0',
            WORKER_HEALTH_PORT: String(32000 + Math.floor(Math.random() * 1000)),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.add(child);
    child.once('exit', () => children.delete(child));
    return child;
}

async function waitFor(predicate, timeoutMs, message) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const value = await predicate();
        if (value) return value;
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(message);
}

await database.connect();
let userId;
try {
    const registration = await request('/auth/register', { method: 'POST', body: JSON.stringify({ email, password: randomUUID(), name: 'Worker Kill E2E' }) });
    userId = registration.user.id;
    const authorization = `Bearer ${registration.token}`;
    const conversation = await request('/conversations', { method: 'POST', headers: { authorization }, body: JSON.stringify({ title: 'Worker kill recovery' }) });
    const firstWorker = startWorker();
    const generation = await request('/chat', {
        method: 'POST', headers: { authorization, 'idempotency-key': randomUUID() },
        body: JSON.stringify({ conversationId: conversation.id, message: '执行进程终止恢复测试' }),
    });
    await waitFor(async () => (await database.query('SELECT status FROM generation WHERE id=?', [generation.generationId]))[0]?.status === 'running', 15_000, 'generation never started');
    firstWorker.kill('SIGKILL');
    const replacement = startWorker();
    const terminal = await waitFor(async () => {
        const [row] = await database.query('SELECT status,error_code,writer_token FROM generation WHERE id=?', [generation.generationId]);
        return row && ['failed', 'cancelled', 'completed'].includes(row.status) ? row : null;
    }, 20_000, 'stale generation was not recovered');
    assert.equal(terminal.status, 'failed');
    assert.equal(terminal.error_code, 'WORKER_LOST');
    assert.equal(terminal.writer_token, null);
    const [attempt] = await database.query('SELECT status,error FROM generation_attempt WHERE generation_id=? ORDER BY attempt DESC LIMIT 1', [generation.generationId]);
    assert.equal(attempt.status, 'failed');
    assert.equal(attempt.error, 'WORKER_LOST');
    replacement.kill('SIGTERM');
    console.log(JSON.stringify({ generationId: generation.generationId, status: terminal.status, errorCode: terminal.error_code, staleWriterFenced: true }, null, 2));
} finally {
    for (const child of children) child.kill('SIGKILL');
    if (userId) await database.execute('DELETE FROM app_user WHERE id=?', [userId]).catch(() => undefined);
    await database.close();
}
