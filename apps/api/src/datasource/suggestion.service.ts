import { createHash } from 'crypto';
import { ForbiddenException, Injectable } from '@nestjs/common';
import { HOME_SUGGESTIONS_PROMPT, parseSuggestionTexts, PROMPT_METADATA } from '@gist/llm';
import { DatabaseService } from '../database/database.service';
import { SchemaService } from '../database/schema.service';
import { LlmService } from '../llm/llm.service';

@Injectable()
export class SuggestionService {
    constructor(
        private readonly db: DatabaseService,
        private readonly schema: SchemaService,
        private readonly llm: LlmService
    ) {}
    async getSuggestions(datasourceId: number, userId: number, requestedLanguage = 'zh-CN'): Promise<string[]> {
        const access = await this.db.query(
            `SELECT 1 FROM data_source d WHERE d.id=? AND (d.created_by IS NULL OR d.created_by=? OR EXISTS
            (SELECT 1 FROM datasource_permission p WHERE p.datasource_id=d.id AND p.user_id=?))`,
            [datasourceId, userId, userId]
        );
        if (!access.length) throw new ForbiddenException('无权访问数据源');
        const language = typeof requestedLanguage === 'string' && /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,2}$/.test(requestedLanguage) ? requestedLanguage : 'zh-CN';
        const schema = await this.schema.getStructuredSchema(datasourceId, userId);
        if (!schema.length) return [];
        const serialized = JSON.stringify(schema);
        const schemaHash = createHash('sha256').update(serialized).digest('hex');
        const key = JSON.stringify({ language, schemaHash, ...PROMPT_METADATA.homeSuggestions });
        const cached = await this.db.query('SELECT questions FROM datasource_suggestions WHERE datasource_id=? AND user_id=?', [datasourceId, userId]);
        if (cached[0]) {
            const payload = cached[0].questions as { key: string; items: string[] };
            if (payload.key === key) return parseSuggestionTexts(JSON.stringify(payload.items));
        }
        // Whole table entries only; never truncate JSON or leave half a column definition.
        const selected: unknown[] = [];
        let remaining = 16000;
        for (const table of schema) {
            const length = JSON.stringify(table).length;
            if (length > remaining) continue;
            selected.push(table);
            remaining -= length;
        }
        if (!selected.length) return [];
        const items = parseSuggestionTexts(await this.llm.chat(HOME_SUGGESTIONS_PROMPT, JSON.stringify({ language, schema: selected }), 0));
        await this.db.execute(
            `INSERT INTO datasource_suggestions (datasource_id,user_id,questions) VALUES (?,?,?::jsonb)
            ON CONFLICT(datasource_id,user_id) DO UPDATE SET questions=EXCLUDED.questions,created_at=NOW()`,
            [datasourceId, userId, JSON.stringify({ key, items, prompt: PROMPT_METADATA.homeSuggestions })]
        );
        return items;
    }
    triggerAsync(datasourceId: number, userId: number): void {
        void this.getSuggestions(datasourceId, userId).catch(() => {});
    }
    invalidateAndRegenerate(datasourceId: number, userId: number): void {
        void this.db
            .execute('DELETE FROM datasource_suggestions WHERE datasource_id=?', [datasourceId])
            .then(() => this.triggerAsync(datasourceId, userId))
            .catch(() => {});
    }
}
