import { DatabaseClient, MEMORY_PROVENANCE_UPGRADE_SQL } from '@gist/database';

// Preserve formal memory provenance; cascade conversation-owned candidates on deletion.
const db = new DatabaseClient();
try {
    await db.withTransaction(async (tx) => {
        await tx.query("SET LOCAL lock_timeout='5s'");
        await tx.query("SET LOCAL statement_timeout='15s'");
        await tx.query(MEMORY_PROVENANCE_UPGRADE_SQL);
    });
    console.log('Memory provenance upgraded; conversations and memory revisions preserved.');
} finally {
    await db.close();
}
