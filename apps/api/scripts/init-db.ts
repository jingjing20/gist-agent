import { Client } from 'pg';
import { loadWorkspaceEnv } from '@gist/config';
import { initializeDemoData } from './demo-data';
import { applyCurrentSchema } from '@gist/database';

loadWorkspaceEnv();
const database = process.env.DB_NAME || 'gist_agent';
if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(database)) throw new Error('DB_NAME 不合法');
const common = {
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 5432,
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || '',
};

async function initDB() {
    const admin = new Client({ ...common, database: 'postgres' });
    await admin.connect();
    const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [database]);
    if (!exists.rowCount) await admin.query(`CREATE DATABASE "${database}"`);
    await admin.end();

    const db = new Client({ ...common, database });
    await db.connect();
    await applyCurrentSchema(db);
    await db.query(
        `INSERT INTO data_source (name, host, port, "user", password, database_name, is_local, description)
      SELECT '本地默认库', $1, $2, $3, $4, $5, 1, '系统默认 PostgreSQL 数据库'
      WHERE NOT EXISTS (SELECT 1 FROM data_source WHERE is_local = 1)`,
        [common.host, common.port, common.user, common.password, database]
    );
    await initializeDemoData(db);
    await configureAgentReadOnlyRole(db);
    await db.end();
    console.log(`PostgreSQL database ${database} initialized successfully.`);
}

async function configureAgentReadOnlyRole(db: Client): Promise<void> {
    const role = process.env.AGENT_DB_USER;
    const password = process.env.AGENT_DB_PASSWORD;
    if (!role && !password) {
        console.warn('AGENT_DB_USER/AGENT_DB_PASSWORD 未配置：开发环境继续复用主连接；生产环境必须配置独立只读账号');
        return;
    }
    if (!role || !password || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(role)) {
        throw new Error('AGENT_DB_USER/AGENT_DB_PASSWORD 必须同时配置，且用户名只能包含字母、数字和下划线');
    }
    const quotedRole = `"${role}"`;
    const passwordLiteral = password.replace(/'/g, "''");
    const exists = await db.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [role]);
    if (exists.rowCount) await db.query(`ALTER ROLE ${quotedRole} WITH LOGIN PASSWORD '${passwordLiteral}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);
    else await db.query(`CREATE ROLE ${quotedRole} WITH LOGIN PASSWORD '${passwordLiteral}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);
    await db.query(`GRANT CONNECT ON DATABASE "${database}" TO ${quotedRole}`);
    await db.query(`GRANT USAGE ON SCHEMA public TO ${quotedRole}`);
    await db.query(`REVOKE CREATE ON SCHEMA public FROM ${quotedRole}`);
    await db.query(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${quotedRole}`);
    const visible = await db.query<{ table_name: string }>(`SELECT DISTINCT table_name FROM datasource_table_catalog WHERE schema_name='public' AND is_agent_visible=TRUE`);
    for (const { table_name: table } of visible.rows) {
        if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(table)) throw new Error(`目录中存在不安全的表名: ${table}`);
        await db.query(`GRANT SELECT ON TABLE public."${table}" TO ${quotedRole}`);
    }
    await db.query(`ALTER ROLE ${quotedRole} SET default_transaction_read_only = on`);
    await db.query(`ALTER ROLE ${quotedRole} SET search_path = public`);
    await db.query(`ALTER ROLE ${quotedRole} SET statement_timeout = '15s'`);
}

initDB().catch((error) => {
    console.error('Failed to initialize database:', error);
    process.exit(1);
});
