import { applyBusinessDefinitionSchema, applyAnalysisStateSchema, DatabaseClient } from '@gist/database';
const db = new DatabaseClient();
try {
    await db.withTransaction(async (tx) => {
        await applyBusinessDefinitionSchema(tx);
        await applyAnalysisStateSchema(tx);
    });
    console.log('Analysis state schema applied');
} finally {
    await db.close();
}
