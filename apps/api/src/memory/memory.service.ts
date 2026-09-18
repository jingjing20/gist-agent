import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService, type QueryRow } from '../database/database.service';
import { MEMORY_TYPES, type MemoryRecordV1, type MemoryType } from '@gist/contracts';

const VALUE_FIELDS: Record<MemoryType, readonly string[]> = {
    metric_definition: ['description', 'formula', 'event', 'window', 'distinctBy', 'filters', 'unit'],
    dimension_definition: ['description', 'members', 'mapping'],
    analysis_preference: ['description', 'format', 'granularity', 'chartType'],
    locale_preference: ['timezone', 'currency', 'locale'],
};

@Injectable()
export class MemoryService {
    constructor(private readonly db: DatabaseService) {}

    async list(userId: number): Promise<MemoryRecordV1[]> {
        const rows = await this.db.query<QueryRow[]>(
            `SELECT * FROM memory_record WHERE user_id=? AND status IN ('active','proposed') AND (expires_at IS NULL OR expires_at>NOW()) ORDER BY status,type,key,created_at DESC`,
            [userId]
        );
        return rows.map(toContract);
    }

    async confirm(id: string, userId: number, expectedVersion: number): Promise<MemoryRecordV1> {
        return this.db.withTransaction(async (conn) => {
            const [rows] = await conn.query<QueryRow[]>(`SELECT * FROM memory_record WHERE id=? AND user_id=? FOR UPDATE`, [id, userId]);
            const candidate = rows[0];
            if (!candidate) throw new NotFoundException('记忆不存在');
            if (candidate.status !== 'proposed' || Number(candidate.version) !== expectedVersion) throw new ConflictException('MEMORY_VERSION_CONFLICT');
            const [activeRows] = await conn.query<QueryRow[]>(
                `SELECT * FROM memory_record WHERE user_id=? AND scope=? AND COALESCE(scope_id,'')=COALESCE(?,'') AND type=? AND key=? AND status='active' FOR UPDATE`,
                [userId, candidate.scope, candidate.scope_id, candidate.type, candidate.key]
            );
            const active = activeRows[0];
            if (active) await conn.execute(`UPDATE memory_record SET status='superseded',updated_at=NOW() WHERE id=?`, [active.id]);
            const nextVersion = active ? Number(active.version) + 1 : 1;
            const [updated] = await conn.query<QueryRow[]>(
                `UPDATE memory_record SET status='active',version=?,supersedes_id=?,confirmed_at=NOW(),updated_at=NOW() WHERE id=? RETURNING *`,
                [nextVersion, active?.id ?? null, candidate.id]
            );
            await conn.execute(`INSERT INTO memory_change_audit(memory_id,user_id,action,previous_version,new_memory_id) VALUES(?,?,'confirm',?,?)`, [candidate.id, userId, expectedVersion, candidate.id]);
            return toContract(updated[0]);
        });
    }

    async correct(id: string, userId: number, expectedVersion: number, value: Record<string, unknown>): Promise<MemoryRecordV1> {
        return this.db.withTransaction(async (conn) => {
            const [rows] = await conn.query<QueryRow[]>(`SELECT * FROM memory_record WHERE id=? AND user_id=? FOR UPDATE`, [id, userId]);
            const current = rows[0];
            if (!current) throw new NotFoundException('记忆不存在');
            if (current.status !== 'active' || Number(current.version) !== expectedVersion) throw new ConflictException('MEMORY_VERSION_CONFLICT');
            validateValue(current.type, value);
            await conn.execute(`UPDATE memory_record SET status='superseded',updated_at=NOW() WHERE id=?`, [id]);
            const [created] = await conn.query<QueryRow[]>(
                `INSERT INTO memory_record(user_id,scope,scope_id,type,key,value,source_message_id,source_quote,status,version,supersedes_id,confirmed_at)
                 VALUES(?,?,?,?,?,?::jsonb,?,?,'active',?,?,NOW()) RETURNING *`,
                [userId, current.scope, current.scope_id, current.type, current.key, JSON.stringify(value), current.source_message_id, current.source_quote, expectedVersion + 1, id]
            );
            await conn.execute(`INSERT INTO memory_change_audit(memory_id,user_id,action,previous_version,new_memory_id) VALUES(?,?,'correct',?,?)`, [id, userId, expectedVersion, created[0].id]);
            return toContract(created[0]);
        });
    }

    async forget(id: string, userId: number, expectedVersion: number): Promise<void> {
        await this.db.withTransaction(async (conn) => {
            const [updated] = await conn.query<QueryRow[]>(
                `UPDATE memory_record SET status='deleted',updated_at=NOW() WHERE id=? AND user_id=? AND status IN ('active','proposed') AND version=? RETURNING id`,
                [id, userId, expectedVersion]
            );
            if (!updated.length) throw new ConflictException('MEMORY_VERSION_CONFLICT');
            await conn.execute(`INSERT INTO memory_change_audit(memory_id,user_id,action,previous_version) VALUES(?,?,'forget',?)`, [id, userId, expectedVersion]);
        });
    }
}

function validateValue(type: unknown, value: Record<string, unknown>): void {
    if (!MEMORY_TYPES.includes(type as MemoryType) || !value || typeof value !== 'object' || Array.isArray(value)) throw new BadRequestException('MEMORY_VALUE_INVALID');
    const serialized = JSON.stringify(value);
    const allowed = new Set(VALUE_FIELDS[type as MemoryType]);
    if (!Object.keys(value).length || serialized.length > 4000 || Object.keys(value).some((key) => !allowed.has(key))) throw new BadRequestException('MEMORY_VALUE_SCHEMA_INVALID');
    if (/(system prompt|ignore (all|previous)|忽略.{0,8}(规则|指令)|调用.{0,8}工具|泄露.{0,8}(密码|密钥))/i.test(serialized)) throw new BadRequestException('MEMORY_VALUE_UNSAFE');
}

function toContract(row: QueryRow): MemoryRecordV1 {
    return { id: row.id, userId: Number(row.user_id), scope: row.scope, ...(row.scope_id ? { scopeId: row.scope_id } : {}), type: row.type, key: row.key,
        value: typeof row.value === 'string' ? JSON.parse(row.value) : row.value, sourceMessageId: row.source_message_id,
        ...(row.source_quote ? { sourceQuote: row.source_quote } : {}), status: row.status, version: Number(row.version),
        ...(row.supersedes_id ? { supersedesId: row.supersedes_id } : {}), ...(row.confirmed_at ? { confirmedAt: new Date(row.confirmed_at).toISOString() } : {}),
        createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString(), ...(row.expires_at ? { expiresAt: new Date(row.expires_at).toISOString() } : {}) };
}
