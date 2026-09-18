import { Injectable, Logger } from '@nestjs/common';
import { DatabaseService, type QueryRow } from '../database/database.service';
import { MEMORY_TYPES, type MemoryPatchV1, type MemoryRecordV1, type MemoryScope, type MemoryType } from '@gist/contracts';

const KEY_PATTERN = /^[a-zA-Z0-9_.:-]{1,100}$/;
const VALUE_FIELDS: Record<MemoryType, readonly string[]> = {
    metric_definition: ['description', 'formula', 'event', 'window', 'distinctBy', 'filters', 'unit'],
    dimension_definition: ['description', 'members', 'mapping'],
    analysis_preference: ['description', 'format', 'granularity', 'chartType'],
    locale_preference: ['timezone', 'currency', 'locale'],
};

@Injectable()
export class MemoryService {
    private readonly logger = new Logger(MemoryService.name);
    constructor(private readonly db: DatabaseService) {}

    async listActive(userId: number, conversationId: string, datasourceId: number | null): Promise<MemoryRecordV1[]> {
        const scopeClauses = [`scope='user'`, `(scope='conversation' AND scope_id=?)`];
        const params: unknown[] = [userId, conversationId];
        if (datasourceId != null) {
            scopeClauses.push(`(scope='datasource' AND scope_id=?)`);
            params.push(String(datasourceId));
        }
        const rows = await this.db.query<QueryRow[]>(
            `SELECT * FROM memory_record
              WHERE user_id=? AND status='active' AND (expires_at IS NULL OR expires_at>NOW())
                AND (${scopeClauses.join(' OR ')})
              ORDER BY type,key,created_at`,
            params
        );
        return rows.map(toContract);
    }

    async applyPatches(input: {
        userId: number;
        conversationId: string;
        datasourceId: number | null;
        sourceMessageId: string;
        patches: MemoryPatchV1[];
    }): Promise<void> {
        const patches = input.patches.slice(0, 12);
        for (const patch of patches) {
            if (patch.op === 'noop') continue;
            try {
                await this.applyPatch(input, patch);
            } catch (error) {
                this.logger.warn(`Memory patch rejected op=${patch.op} conversationId=${input.conversationId}: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
    }

    private async applyPatch(input: { userId: number; conversationId: string; datasourceId: number | null; sourceMessageId: string }, patch: Exclude<MemoryPatchV1, { op: 'noop' }>) {
        if (patch.evidence.length < 1 || patch.evidence.length > 500) throw new Error('MEMORY_EVIDENCE_INVALID');
        if (patch.op === 'add') {
            validateDefinition(patch.type, patch.key, patch.value);
            const { scope, scopeId } = resolveScope(patch.type, input.conversationId, input.datasourceId);
            await this.db.withTransaction(async (conn) => {
                await conn.query(`SELECT pg_advisory_xact_lock(hashtextextended(?,0))`, [`${input.userId}:${scope}:${scopeId ?? ''}:${patch.type}:${patch.key}`]);
                const [duplicate] = await conn.query<QueryRow[]>(
                    `SELECT id FROM memory_record WHERE source_message_id=? AND scope=? AND COALESCE(scope_id,'')=COALESCE(?,'') AND type=? AND key=? LIMIT 1`,
                    [input.sourceMessageId, scope, scopeId, patch.type, patch.key]
                );
                if (duplicate.length) return;
                const [active] = await conn.query<QueryRow[]>(
                    `SELECT id FROM memory_record WHERE user_id=? AND scope=? AND COALESCE(scope_id,'')=COALESCE(?,'') AND type=? AND key=? AND status='active' FOR UPDATE`,
                    [input.userId, scope, scopeId, patch.type, patch.key]
                );
                const status = active.length ? 'proposed' : 'active';
                await conn.execute(
                    `INSERT INTO memory_record(user_id,scope,scope_id,type,key,value,source_message_id,source_quote,status,version,confirmed_at)
                     VALUES(?,?,?,?,?,?::jsonb,?,?,?,1,CASE WHEN ?='active' THEN NOW() ELSE NULL END)`,
                    [input.userId, scope, scopeId, patch.type, patch.key, JSON.stringify(patch.value), input.sourceMessageId, patch.evidence, status, status]
                );
            });
            return;
        }
        await this.db.withTransaction(async (conn) => {
            const [rows] = await conn.query<QueryRow[]>(`SELECT * FROM memory_record WHERE id=? AND user_id=? FOR UPDATE`, [patch.targetId, input.userId]);
            const target = rows[0];
            if (!target) throw new Error('MEMORY_NOT_FOUND');
            const [duplicate] = await conn.query<QueryRow[]>(`SELECT id FROM memory_record WHERE source_message_id=? AND supersedes_id=? LIMIT 1`, [input.sourceMessageId, target.id]);
            if (duplicate.length) return;
            if (target.status !== 'active' || Number(target.version) !== patch.expectedVersion) {
                if (patch.op === 'supersede') {
                    validateDefinition(target.type, target.key, patch.value);
                    await conn.execute(
                        `INSERT INTO memory_record(user_id,scope,scope_id,type,key,value,source_message_id,source_quote,status,version,supersedes_id)
                         VALUES(?,?,?,?,?,?::jsonb,?,?,'proposed',?,?)`,
                        [input.userId, target.scope, target.scope_id, target.type, target.key, JSON.stringify(patch.value), input.sourceMessageId, patch.evidence, patch.expectedVersion + 1, target.id]
                    );
                    return;
                }
                throw new Error('MEMORY_VERSION_CONFLICT');
            }
            await conn.execute(`UPDATE memory_record SET status=?,updated_at=NOW() WHERE id=? AND status='active' AND version=?`, [patch.op === 'delete' ? 'deleted' : 'superseded', target.id, patch.expectedVersion]);
            if (patch.op === 'supersede') {
                validateDefinition(target.type, target.key, patch.value);
                await conn.execute(
                    `INSERT INTO memory_record(user_id,scope,scope_id,type,key,value,source_message_id,source_quote,status,version,supersedes_id,confirmed_at)
                     VALUES(?,?,?,?,?,?::jsonb,?,?,'active',?,?,NOW())`,
                    [input.userId, target.scope, target.scope_id, target.type, target.key, JSON.stringify(patch.value), input.sourceMessageId, patch.evidence, patch.expectedVersion + 1, target.id]
                );
            }
        });
    }
}

function resolveScope(type: MemoryType, conversationId: string, datasourceId: number | null): { scope: MemoryScope; scopeId: string | null } {
    if (type === 'locale_preference' || type === 'analysis_preference') return { scope: 'user', scopeId: null };
    if (datasourceId != null) return { scope: 'datasource', scopeId: String(datasourceId) };
    return { scope: 'conversation', scopeId: conversationId };
}

function validateDefinition(type: MemoryType, key: string, value: Record<string, unknown>): void {
    if (!MEMORY_TYPES.includes(type) || !KEY_PATTERN.test(key)) throw new Error('MEMORY_DEFINITION_INVALID');
    const serialized = JSON.stringify(value);
    if (!value || Array.isArray(value) || typeof value !== 'object' || serialized.length > 4000) throw new Error('MEMORY_VALUE_INVALID');
    const allowed = new Set(VALUE_FIELDS[type]);
    if (!Object.keys(value).length || Object.keys(value).some((field) => !allowed.has(field))) throw new Error('MEMORY_VALUE_SCHEMA_INVALID');
    if (containsInstructionLikeText(value)) throw new Error('MEMORY_VALUE_UNSAFE');
}

function containsInstructionLikeText(value: unknown): boolean {
    if (typeof value === 'string') return /(system prompt|ignore (all|previous)|忽略.{0,8}(规则|指令)|调用.{0,8}工具|泄露.{0,8}(密码|密钥))/i.test(value);
    if (Array.isArray(value)) return value.some(containsInstructionLikeText);
    return !!value && typeof value === 'object' && Object.values(value).some(containsInstructionLikeText);
}

function toContract(row: QueryRow): MemoryRecordV1 {
    return {
        id: row.id, userId: Number(row.user_id), scope: row.scope, ...(row.scope_id ? { scopeId: row.scope_id } : {}),
        type: row.type, key: row.key, value: typeof row.value === 'string' ? JSON.parse(row.value) : row.value,
        sourceMessageId: row.source_message_id, ...(row.source_quote ? { sourceQuote: row.source_quote } : {}), status: row.status,
        version: Number(row.version), ...(row.supersedes_id ? { supersedesId: row.supersedes_id } : {}),
        ...(row.confirmed_at ? { confirmedAt: new Date(row.confirmed_at).toISOString() } : {}),
        createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString(),
        ...(row.expires_at ? { expiresAt: new Date(row.expires_at).toISOString() } : {}),
    };
}
