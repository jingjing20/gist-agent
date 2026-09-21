import { BusinessDefinitionRepository, DatabaseClient, positiveInteger } from '@gist/database';
// Explicit deployment operation; requires a datasource owner, never selects an arbitrary user.
const [user, datasource] = process.argv.slice(2);
if (!user || !datasource) throw new Error('用法：node scripts/import-business-definition-seed.mjs <ownerUserId> <datasourceId>（先执行数据库迁移）');
const db = new DatabaseClient();
try {
    console.log(await new BusinessDefinitionRepository(db).importSaasSeed(positiveInteger(user), positiveInteger(datasource)));
} finally {
    await db.close();
}
