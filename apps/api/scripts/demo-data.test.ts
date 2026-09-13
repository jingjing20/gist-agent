import assert from 'node:assert/strict';
import test from 'node:test';
import { initializeDemoData } from './demo-data';

class QueryRecorder {
    readonly calls: Array<{ sql: string; values?: unknown[] }> = [];

    async query(sql: string, values?: unknown[]): Promise<void> {
        this.calls.push({ sql, values });
    }
}

test('initializes the three preset business tables with the complete demo dataset', async () => {
    const db = new QueryRecorder();

    await initializeDemoData(db, {
        now: new Date('2026-09-13T00:00:00.000Z'),
        random: () => 0.5,
    });

    const sql = db.calls.map((call) => call.sql).join('\n');
    assert.match(sql, /CREATE TABLE IF NOT EXISTS platform_info/);
    assert.match(sql, /CREATE TABLE IF NOT EXISTS daily_active_stats/);
    assert.match(sql, /CREATE TABLE IF NOT EXISTS user_behavior_log/);
    assert.doesNotMatch(sql, /DROP TABLE/i);

    const platformInsert = db.calls.find((call) => call.sql.includes('INSERT INTO platform_info'));
    const dailyInsert = db.calls.find((call) => call.sql.includes('INSERT INTO daily_active_stats'));
    const behaviorInsert = db.calls.find((call) => call.sql.includes('INSERT INTO user_behavior_log'));

    assert.equal((platformInsert?.values?.[0] as unknown[]).length, 3);
    assert.equal((dailyInsert?.values?.[0] as unknown[]).length, 270);
    assert.equal((behaviorInsert?.values?.[0] as unknown[]).length, 1800);
    assert.match(dailyInsert?.sql ?? '', /WHERE NOT EXISTS \(SELECT 1 FROM daily_active_stats\)/);
    assert.match(behaviorInsert?.sql ?? '', /WHERE NOT EXISTS \(SELECT 1 FROM user_behavior_log\)/);
});
