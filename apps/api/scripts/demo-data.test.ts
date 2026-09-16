import assert from 'node:assert/strict';
import test from 'node:test';
import { initializeDemoData } from './demo-data';

class QueryRecorder {
    readonly calls: Array<{ sql: string; values?: unknown[] }> = [];

    async query(sql: string, values?: unknown[]): Promise<void> {
        this.calls.push({ sql, values });
    }

    rowsFor(tableName: string): Array<Record<string, unknown>> {
        const call = this.calls.find((item) => item.sql.startsWith(`INSERT INTO ${tableName} `));
        assert.ok(call?.values?.[0], `missing seed insert for ${tableName}`);
        return JSON.parse(String(call.values[0]));
    }
}

test('replaces the lightweight preset with the complete SaaS analytics dataset', async () => {
    const db = new QueryRecorder();
    await initializeDemoData(db, { now: new Date('2026-09-15T00:00:00.000Z') });

    const sql = db.calls.map((call) => call.sql).join('\n');
    for (const table of [
        'marketing_campaigns',
        'product_releases',
        'customer_accounts',
        'product_users',
        'subscriptions',
        'invoices',
        'experiment_assignments',
        'product_events',
        'support_tickets',
        'daily_business_metrics',
    ]) {
        assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
    }
    assert.match(sql, /DROP TABLE IF EXISTS platform_info/);
    assert.match(sql, /DROP TABLE IF EXISTS daily_active_stats/);
    assert.match(sql, /DROP TABLE IF EXISTS user_behavior_log/);
    assert.match(sql, /dataset_key = 'basic_platform_demo'/);

    assert.equal(db.rowsFor('marketing_campaigns').length, 8);
    assert.equal(db.rowsFor('product_releases').length, 6);
    assert.equal(db.rowsFor('customer_accounts').length, 300);
    assert.equal(db.rowsFor('product_users').length, 1570);
    assert.equal(db.rowsFor('subscriptions').length, 300);
    assert.equal(db.rowsFor('daily_business_metrics').length, 120);
    assert.ok(db.rowsFor('invoices').length > 500);
    assert.ok(db.rowsFor('experiment_assignments').length > 100);
    assert.ok(db.rowsFor('product_events').length > 10_000);
    assert.ok(db.rowsFor('support_tickets').length > 400);

    const events = db.rowsFor('product_events');
    const businessKeys = events.map((row) => `${row.user_id}|${row.session_id}|${row.event_name}|${row.event_time}`);
    assert.ok(new Set(businessKeys).size < businessKeys.length, 'expected logical duplicate events');
    assert.ok(
        events.some((row) => Date.parse(String(row.ingested_at)) - Date.parse(String(row.event_time)) >= 2 * 24 * 60 * 60 * 1000),
        'expected late-arriving events'
    );

    const catalogCall = db.calls.find((call) => call.sql.includes('INSERT INTO datasource_table_catalog'));
    assert.equal(catalogCall?.values?.[0], 'saas_growth_demo');
    assert.equal(JSON.parse(String(catalogCall?.values?.[1])).length, 10);
    assert.equal(db.calls.at(-1)?.sql, 'COMMIT');
});
