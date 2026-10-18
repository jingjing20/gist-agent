import { createRequire } from 'node:module';
import { userInfo } from 'node:os';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const apiRequire = createRequire(new URL('../apps/api/package.json', import.meta.url));
const { config } = apiRequire('dotenv');
const { Client } = apiRequire('pg');
config({ path: new URL('../.env', import.meta.url), quiet: true });

const host = process.env.DB_HOST || '127.0.0.1';
if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
    throw new Error('本机启动仅支持本地 PostgreSQL；请检查 DB_HOST。');
}
const appUser = process.env.DB_USER || 'postgres';
const database = process.env.DB_NAME || 'gist_agent';
for (const name of [appUser, database]) {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) throw new Error('数据库名称或账号不合法。');
}
const adminUser = userInfo().username;
if (appUser === adminUser) throw new Error('DB_USER 请使用独立的应用账号，不要使用本机管理员。');
const connection = { host, port: Number(process.env.DB_PORT || 5432), user: adminUser };
let admin;
for (let attempt = 0; attempt < 30; attempt++) {
    admin = new Client({ ...connection, database: 'postgres' });
    try {
        await admin.connect();
        break;
    } catch (error) {
        await admin.end().catch(() => {});
        if (attempt === 29) throw new Error(`无法连接本机 PostgreSQL ${host}:${connection.port}，请检查服务端口及本机管理员认证。`, { cause: error });
        await delay(500);
    }
}
try {
    if (!(await admin.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [appUser])).rowCount) {
        if (!process.env.DB_PASSWORD) throw new Error('请配置 DB_PASSWORD。');
        const password = process.env.DB_PASSWORD.replace(/'/g, "''");
        await admin.query(`CREATE ROLE "${appUser}" WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '${password}'`);
    }
    if (!(await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [database])).rowCount) {
        await admin.query(`CREATE DATABASE "${database}" OWNER "${appUser}"`);
    }
} finally {
    await admin.end();
}
// Use the existing local administrator only for schema and reader-role setup.
const init = spawnSync('pnpm', ['init-db'], {
    stdio: 'inherit',
    env: { ...process.env, DB_USER: adminUser },
});
if (init.error) throw init.error;
if (init.status !== 0) process.exit(init.status || 1);
const db = new Client({ ...connection, database });
try {
    await db.connect();
    await db.query(`GRANT USAGE, CREATE ON SCHEMA public TO "${appUser}"`);
    await db.query(`GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO "${appUser}"`);
    await db.query(`GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO "${appUser}"`);
} finally {
    await db.end();
}
console.log('本机数据库已就绪。');
