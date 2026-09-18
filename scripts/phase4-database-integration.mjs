import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { applyPhase4Schema, DatabaseClient } from '@gist/database';
import { databaseConfig, loadWorkspaceEnv } from '@gist/config';

loadWorkspaceEnv();
const configuration = databaseConfig();
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const role = `phase4_reader_${suffix}`;
const allowedTable = `phase4_allowed_${suffix}`;
const privateTable = `phase4_private_${suffix}`;
const password = randomBytes(24).toString('hex');
const ident = (value) => `"${value.replaceAll('"', '""')}"`;
const admin = new DatabaseClient(configuration);
let reader;

try {
    await admin.connect();
    await applyPhase4Schema(admin);
    await applyPhase4Schema(admin);
    const columns = await admin.query(
        `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='query_artifact' AND column_name='result_quality'`
    );
    assert.equal(columns.length, 1);
    const policies = await admin.query(`SELECT to_regclass('public.datasource_column_policy') AS name`);
    assert.equal(policies[0].name, 'datasource_column_policy');

    await admin.query(`CREATE TABLE ${ident(allowedTable)} (id integer primary key, value text)`);
    await admin.query(`INSERT INTO ${ident(allowedTable)} VALUES (1, 'visible')`);
    await admin.query(`CREATE TABLE ${ident(privateTable)} (secret text)`);
    await admin.query(`INSERT INTO ${ident(privateTable)} VALUES ('hidden')`);
    await admin.query(`CREATE ROLE ${ident(role)} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);
    await admin.query(`GRANT CONNECT ON DATABASE ${ident(configuration.database)} TO ${ident(role)}`);
    await admin.query(`GRANT USAGE ON SCHEMA public TO ${ident(role)}`);
    await admin.query(`GRANT SELECT ON ${ident(allowedTable)} TO ${ident(role)}`);
    await admin.query(`ALTER ROLE ${ident(role)} SET default_transaction_read_only=on`);
    await admin.query(`ALTER ROLE ${ident(role)} SET statement_timeout='100ms'`);

    reader = new DatabaseClient({ ...configuration, user: role, password });
    await reader.connect();
    assert.equal((await reader.query(`SELECT value FROM ${ident(allowedTable)}`))[0].value, 'visible');
    await assert.rejects(() => reader.query(`INSERT INTO ${ident(allowedTable)} VALUES (2, 'write')`), /read-only|permission denied/i);
    await assert.rejects(() => reader.query(`SELECT * FROM ${ident(privateTable)}`), /permission denied/i);
    await assert.rejects(() => reader.query('SELECT pg_sleep(1)'), /statement timeout/i);
    console.log('Phase 4 database role, migration, and timeout integration passed');
} finally {
    await reader?.close().catch(() => undefined);
    await admin.query(`DROP TABLE IF EXISTS ${ident(allowedTable)}`).catch(() => undefined);
    await admin.query(`DROP TABLE IF EXISTS ${ident(privateTable)}`).catch(() => undefined);
    await admin.query(`REASSIGN OWNED BY ${ident(role)} TO CURRENT_USER`).catch(() => undefined);
    await admin.query(`DROP OWNED BY ${ident(role)}`).catch(() => undefined);
    await admin.query(`DROP ROLE IF EXISTS ${ident(role)}`).catch(() => undefined);
    await admin.close().catch(() => undefined);
}
