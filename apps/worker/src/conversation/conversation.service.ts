import { Injectable } from '@nestjs/common';
import { DatabaseService, type QueryRow } from '../database/database.service';

/** The Worker only reads its owned request; analysis history is assembled by AnalysisStateRepository. */
@Injectable()
export class ConversationService {
    constructor(private readonly db: DatabaseService) {}
    async getMessage(id: string, conversationId: string, userId: number): Promise<QueryRow | null> {
        const rows = await this.db.query<QueryRow[]>(
            `SELECT m.* FROM message m JOIN conversation c ON c.id=m.conversation_id
             WHERE m.id=? AND m.conversation_id=? AND c.user_id=?`,
            [id, conversationId, userId]
        );
        return rows[0] ?? null;
    }
}
