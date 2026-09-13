import { randomUUID } from 'node:crypto';
import { DatabaseClient } from '@gist/database';
import { loadWorkspaceEnv } from '@gist/config';

loadWorkspaceEnv();
const api = process.env.API_BASE_URL || 'http://127.0.0.1:3000/api';
const email = `smoke-${randomUUID()}@example.test`;
const database = new DatabaseClient();

async function request(path, init = {}) {
  const response = await fetch(`${api}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers || {}) },
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`${init.method || 'GET'} ${path}: ${response.status} ${JSON.stringify(body)}`);
  return body;
}

async function waitFor(generationId, token) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const history = await request(`/chat/generations/${generationId}/events?after_sequence=0`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (history.mode === 'events') {
      const done = history.events.find((event) => event.type === 'done');
      if (done) return { status: done.status || 'completed', eventCount: history.events.length, error: done.error };
    } else if (['completed', 'failed', 'cancelled'].includes(history.snapshot.status)) {
      return { status: history.snapshot.status, eventCount: history.snapshot.sequence, error: history.snapshot.error };
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`generation ${generationId} timed out`);
}

try {
  const registration = await request('/auth/register', {
    method: 'POST',
    body: JSON.stringify({ email, password: 'smoke-password', name: 'Smoke' }),
  });
  const authorization = `Bearer ${registration.token}`;
  const conversations = await Promise.all([
    request('/conversations', { method: 'POST', headers: { authorization }, body: JSON.stringify({ title: 'Smoke A' }) }),
    request('/conversations', { method: 'POST', headers: { authorization }, body: JSON.stringify({ title: 'Smoke B' }) }),
  ]);
  const generations = await Promise.all(conversations.map((conversation, index) => request('/chat', {
    method: 'POST',
    headers: { authorization, 'idempotency-key': randomUUID() },
    body: JSON.stringify({ conversationId: conversation.id, message: `并发测试 ${index + 1}` }),
  })));
  const results = await Promise.all(generations.map((generation) => waitFor(generation.generationId, registration.token)));
  if (results.some((result) => result.status !== 'completed')) throw new Error(`unexpected statuses: ${JSON.stringify(results)}`);
  console.log(JSON.stringify({ conversations: conversations.length, generations: results }, null, 2));
} finally {
  await database.execute('DELETE FROM app_user WHERE email=?', [email]).catch(() => undefined);
  await database.close();
}
