import { applyBusinessDefinitionSchema, DatabaseClient } from '@gist/database';
// Additive migration only. Does not seed demo data or alter existing generations.
const db = new DatabaseClient();
try {
    await db.withTransaction(async (tx) => {
        await applyBusinessDefinitionSchema(tx);
    });
    console.log('Business definition schema applied');
} finally {
    await db.close();
}
