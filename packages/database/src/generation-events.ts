import { randomUUID } from 'node:crypto';
import type { TransactionConnection } from './index';

/** Persist each event and its delivery request under the generation row lock. */
export async function enqueueGenerationEvent(
    tx: TransactionConnection,
    identity: { id: string; userId: number; conversationId: string; messageId: string },
    event: { type: string; [key: string]: unknown }
): Promise<void> {
    const [rows] = await tx.query('UPDATE generation SET last_sequence=last_sequence+1,updated_at=NOW() WHERE id=? RETURNING last_sequence', [identity.id]);
    if (!rows.length) throw new Error('Generation no longer exists');
    const eventId = randomUUID();
    const payload = {
        ...event,
        eventId,
        streamId: '0-0',
        generationId: identity.id,
        conversationId: identity.conversationId,
        messageId: identity.messageId,
        sequence: Number(rows[0].last_sequence),
        occurredAt: new Date().toISOString(),
    };
    await tx.execute(
        `INSERT INTO generation_event(generation_id,user_id,conversation_id,message_id,sequence,event_type,payload)
        VALUES (?,?,?,?,?,?,?::jsonb)`,
        [identity.id, identity.userId, identity.conversationId, identity.messageId, payload.sequence, event.type, JSON.stringify(payload)]
    );
    await tx.execute("INSERT INTO outbox_event(id,aggregate_id,type,payload) VALUES (?,?,'generation.event',?::jsonb)", [
        eventId,
        identity.id,
        JSON.stringify({
            version: 1,
            kind: 'generation.event',
            generationId: identity.id,
            userId: identity.userId,
            conversationId: identity.conversationId,
            messageId: identity.messageId,
            sequence: payload.sequence,
            event: payload,
        }),
    ]);
}
