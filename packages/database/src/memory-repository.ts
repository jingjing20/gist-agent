import type { DatasourceMemory, MemoryContent, MemoryCandidate } from '@gist/contracts';
import type { DatabaseClient, QueryRow } from './index';

type Session = { query(sql: string, params?: unknown[]): Promise<QueryRow[]> };
export class MemoryError extends Error {
    constructor(
        public readonly status: 400 | 404 | 409,
        message: string
    ) {
        super(message);
    }
}
export function positiveInteger(value: unknown): number {
    if ((typeof value !== 'number' && typeof value !== 'string') || !/^[1-9]\d*$/.test(String(value)) || !Number.isSafeInteger(Number(value)))
        throw new MemoryError(400, '版本或 ID 必须为正整数');
    return Number(value);
}
export function memoryId(value: string): string {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw new MemoryError(400, '记忆 ID 格式错误');
    return value;
}
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
function text(v: unknown, max = 4000): string {
    if (typeof v !== 'string' || !v.trim() || v.length > max) throw new MemoryError(400, '内容不能为空或超出长度限制');
    return v.trim();
}
export function validateMemory(v: unknown): MemoryContent {
    if (!object(v) || Object.keys(v).some((k) => !['name', 'description'].includes(k)))
        throw new MemoryError(400, '存在不允许的记忆字段');
    return { name: text(v.name, 200), description: text(v.description) };
}
const normalizedName = (name: string) => name.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');
const SELECT = `SELECT d.id, d.datasource_id, d.created_by, d.created_at, d.status AS current_status,
 r.version, r.content, r.status, r.source, r.source_message_id, r.confirmed_by, r.created_at AS updated_at
 FROM datasource_memory d JOIN datasource_memory_revision r ON r.memory_id=d.id`;
function record(row: QueryRow): DatasourceMemory {
    return {
        name: row.content.name,
        description: row.content.description,
        id: row.id,
        datasourceId: row.datasource_id,
        version: row.version,
        status: row.current_status === 'deleted' ? 'deleted' : row.status,
        source: row.source,
        sourceMessageId: row.source_message_id,
        createdBy: row.created_by,
        confirmedBy: row.confirmed_by,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}
export class MemoryRepository {
    constructor(private readonly db: DatabaseClient) {}
    private async transaction<T>(fn: (s: Session) => Promise<T>): Promise<T> {
        try {
            return await this.db.withTransaction((tx) => fn({ query: async (sql, params) => (await tx.query(sql, params))[0] }));
        } catch (e) {
            if ((e as { code?: string }).code === '23505') throw new MemoryError(409, '同数据源已存在此名称，请刷新后重试');
            throw e;
        }
    }
    private async authorize(s: Session, ds: number, user: number, write: boolean): Promise<void> {
        const rows = await s.query(
            `SELECT d.id FROM data_source d WHERE d.id=? AND
          ${write ? 'd.created_by=?' : '(d.created_by=? OR d.created_by IS NULL OR EXISTS (SELECT 1 FROM datasource_permission p WHERE p.datasource_id=d.id AND p.user_id=?))'} FOR SHARE OF d`,
            write ? [ds, user] : [ds, user, user]
        );
        if (!rows.length) throw new MemoryError(404, '数据源或记忆不可访问');
    }
    async list(user: number, ds: number, options: { q?: string; cursor?: string; limit?: number } = {}) {
        positiveInteger(ds);
        const limit = options.limit === undefined ? 20 : positiveInteger(options.limit);
        if (limit > 100) throw new MemoryError(400, '分页或类型错误');
        if (options.cursor) memoryId(options.cursor);
        return this.transaction(async (s) => {
            await this.authorize(s, ds, user, false);
            const params: unknown[] = [ds];
            let where = "d.datasource_id=? AND d.status='active' AND r.version=d.version";
            if (options.q) {
                where += " AND POSITION(LOWER(?) IN LOWER(CONCAT_WS(' ',r.content->>'name',r.content->>'description')))>0";
                params.push(options.q);
            }
            if (options.cursor) {
                where += ' AND d.id>?::uuid';
                params.push(options.cursor);
            }
            params.push(limit + 1);
            const rows = await s.query(`${SELECT} WHERE ${where} ORDER BY d.id LIMIT ?`, params);
            return {
                items: rows.slice(0, limit).map((r) => record(r)),
                nextCursor: rows.length > limit ? (rows[limit - 1].id as string) : null,
            };
        });
    }
    /** One statement observes one revision set. No runtime fixture fallback, no paging across snapshots. */
    async snapshot(user: number, ds: number): Promise<DatasourceMemory[]> {
        return this.transaction(async (s) => {
            await this.authorize(s, ds, user, false);
            const rows = await s.query(`${SELECT} WHERE d.datasource_id=? AND d.status='active' AND r.version=d.version ORDER BY d.id`, [ds]);
            return rows.map((r) => record(r));
        });
    }
    async get(user: number, id: string, version?: number): Promise<DatasourceMemory> {
        memoryId(id);
        if (version !== undefined) positiveInteger(version);
        return this.transaction(async (s) => {
            const rows = await s.query(`${SELECT} WHERE d.id=? AND r.version=${version === undefined ? 'd.version' : '?'}`, version === undefined ? [id] : [id, version]);
            if (!rows.length) throw new MemoryError(404, '记忆不存在');
            await this.authorize(s, rows[0].datasource_id, user, false);
            return record(rows[0]);
        });
    }
    private async save(
        s: Session,
        user: number,
        ds: number,
        content: MemoryContent,
        id?: string,
        expected?: number,
        sourceMessageId?: string,
        deleted = false
    ): Promise<DatasourceMemory> {
        await this.authorize(s, ds, user, true);
        let version = 1;
        const status = deleted ? 'deleted' : 'active';
        if (id) {
            const rows = await s.query('SELECT version,status FROM datasource_memory WHERE id=? AND datasource_id=? FOR UPDATE', [id, ds]);
            if (!rows.length) throw new MemoryError(404, '记忆不存在');
            if (rows[0].version !== expected || rows[0].status !== 'active') throw new MemoryError(409, '记忆已变化，请刷新后重试');
            version = rows[0].version + 1;
            await s.query('UPDATE datasource_memory SET version=?,status=?,normalized_name=?,updated_at=NOW() WHERE id=?', [version, status, normalizedName(content.name), id]);
        } else {
            const rows = await s.query('INSERT INTO datasource_memory(datasource_id,version,status,normalized_name,created_by) VALUES (?,1,?,?,?) RETURNING id', [
                ds,
                status,
                normalizedName(content.name),
                user,
            ]);
            id = rows[0].id;
        }
        await s.query('INSERT INTO datasource_memory_revision(memory_id,version,content,status,source,source_message_id,confirmed_by) VALUES (?,?,?::jsonb,?,?,?,?)', [
            id,
            version,
            JSON.stringify(content),
            status,
            sourceMessageId ? 'conversation' : 'manual',
            sourceMessageId ?? null,
            user,
        ]);
        const rows = await s.query(`${SELECT} WHERE d.id=? AND r.version=?`, [id, version]);
        return record(rows[0]);
    }
    /** An explicit user instruction is saved once per source message. */
    async rememberFromConversation(user: number, ds: number, sourceMessageId: string, body: unknown) {
        memoryId(sourceMessageId);
        const content = validateMemory(body);
        return this.transaction(async (session) => {
            await this.authorize(session, ds, user, true);
            const existing = await session.query(
                `${SELECT} WHERE d.datasource_id=? AND r.source_message_id=?`,
                [ds, sourceMessageId]
            );
            if (existing.length) {
                const current = await session.query(`${SELECT} WHERE d.id=? AND r.version=d.version`, [existing[0].id]);
                return record(current[0]);
            }
            return this.save(session, user, ds, content, undefined, undefined, sourceMessageId);
        });
    }
    async create(user: number, ds: number, body: unknown) {
        positiveInteger(ds);
        const content = validateMemory(body);
        return this.transaction((s) => this.save(s, user, ds, content));
    }
    async update(user: number, id: string, expected: number, patch: unknown, deleted = false) {
        memoryId(id);
        positiveInteger(expected);
        if (!object(patch)) throw new MemoryError(400, '内容格式错误');
        return this.transaction(async (s) => {
            const rows = await s.query(`${SELECT} WHERE d.id=? AND r.version=d.version`, [id]);
            if (!rows.length) throw new MemoryError(404, '记忆不存在');
            const previous = { ...rows[0].content };
            const content = deleted ? rows[0].content : validateMemory({ ...previous, ...patch });
            return this.save(s, user, rows[0].datasource_id, content, id, expected, undefined, deleted);
        });
    }
    /** Drafts are visible only after the owning generation commits completed. */
    async propose(user: number, ds: number, generationId: string, writerToken: string, input: { content: unknown; memoryId?: string; expectedVersion?: number }) {
        const content = validateMemory(input.content);
        if (input.memoryId) {
            memoryId(input.memoryId);
            positiveInteger(input.expectedVersion);
        } else if (input.expectedVersion !== undefined) throw new MemoryError(400, '修改候选必须指定记忆');
        return this.transaction(async (s) => {
            const generations = await s.query(
                "SELECT request_message_id FROM generation WHERE id=? AND user_id=? AND COALESCE(datasource_id,(SELECT id FROM data_source WHERE is_local=1 ORDER BY id LIMIT 1))=? AND writer_token=? AND status IN ('starting','running') FOR UPDATE",
                [generationId, user, ds, writerToken]
            );
            if (!generations.length) throw new MemoryError(409, '任务已停止或写入凭证失效');
            await this.authorize(s, ds, user, true);
            if (input.memoryId) {
                const target = await s.query("SELECT version FROM datasource_memory WHERE id=? AND datasource_id=? AND status='active'", [input.memoryId, ds]);
                if (!target.length) throw new MemoryError(404, '目标定义不可访问');
                if (target[0].version !== input.expectedVersion) throw new MemoryError(409, '目标记忆已变化');
            }
            const count = await s.query('SELECT COUNT(*)::int AS count FROM datasource_memory_candidate WHERE generation_id=?', [generationId]);
            if (count[0].count >= 10) throw new MemoryError(409, '本轮候选已达上限');
            const rows = await s.query(
                `INSERT INTO datasource_memory_candidate(datasource_id,user_id,generation_id,source_message_id,memory_id,expected_version,content)
             VALUES (?,?,?,?,?,?,?::jsonb) RETURNING id`,
                [ds, user, generationId, generations[0].request_message_id, input.memoryId ?? null, input.expectedVersion ?? null, JSON.stringify(content)]
            );
            return { candidateId: rows[0].id, status: 'draft', message: '任务成功后可在记忆页面确认；尚未保存为正式记忆' };
        });
    }
    async candidates(user: number, ds: number, conversationId?: string): Promise<MemoryCandidate[]> {
        positiveInteger(ds);
        if (conversationId) memoryId(conversationId);
        return this.transaction(async (s) => {
            await this.authorize(s, ds, user, true);
            const rows = await s.query(
                `SELECT c.* FROM datasource_memory_candidate c JOIN generation g ON g.id=c.generation_id
             WHERE c.datasource_id=? AND c.user_id=? AND c.status='pending' AND g.status='completed'
             ${conversationId ? 'AND g.conversation_id=?' : ''} ORDER BY c.created_at,c.id`,
                conversationId ? [ds, user, conversationId] : [ds, user]
            );
            return rows.map((c) => ({
                id: c.id,
                datasourceId: c.datasource_id,
                version: c.version,
                content: validateMemory({ name: c.content.name, description: c.content.description }),
                memoryId: c.memory_id,
                expectedVersion: c.expected_version,
                sourceMessageId: c.source_message_id,
                generationId: c.generation_id,
                status: c.status,
            }));
        });
    }
    async decide(user: number, id: string, expected: number, accept: boolean) {
        memoryId(id);
        positiveInteger(expected);
        return this.transaction(async (s) => {
            const rows = await s.query(
                `SELECT c.* FROM datasource_memory_candidate c JOIN generation g ON g.id=c.generation_id
             WHERE c.id=? AND c.user_id=? AND g.status='completed' FOR UPDATE OF c`,
                [id, user]
            );
            if (!rows.length) throw new MemoryError(404, '候选不可访问');
            const c = rows[0];
            await this.authorize(s, c.datasource_id, user, true);
            if (c.status === (accept ? 'accepted' : 'rejected') && expected === c.version - 1)
                return { status: c.status, memoryId: c.result_memory_id, version: c.result_version };
            if (c.status !== 'pending' || c.version !== expected) throw new MemoryError(409, '候选已变化，请刷新后重试');
            const result = accept
                ? await this.save(s, user, c.datasource_id, validateMemory(c.content), c.memory_id ?? undefined, c.expected_version ?? undefined, c.source_message_id)
                : null;
            await s.query('UPDATE datasource_memory_candidate SET status=?,version=version+1,result_memory_id=?,result_version=? WHERE id=?', [
                accept ? 'accepted' : 'rejected',
                result?.id ?? null,
                result?.version ?? null,
                id,
            ]);
            return { status: accept ? 'accepted' : 'rejected', memoryId: result?.id ?? null, version: result?.version ?? null };
        });
    }
}

