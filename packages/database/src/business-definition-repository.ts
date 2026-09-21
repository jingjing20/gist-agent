import type { BusinessDefinition, BusinessDefinitionContent, BusinessDefinitionCandidate } from '@gist/contracts';
import type { DatabaseClient, QueryRow } from './index';

type Session = { query(sql: string, params?: unknown[]): Promise<QueryRow[]> };
export class DefinitionError extends Error {
    constructor(
        public readonly status: 400 | 404 | 409,
        message: string
    ) {
        super(message);
    }
}
export function positiveInteger(value: unknown): number {
    if ((typeof value !== 'number' && typeof value !== 'string') || !/^[1-9]\d*$/.test(String(value)) || !Number.isSafeInteger(Number(value)))
        throw new DefinitionError(400, '版本或 ID 必须为正整数');
    return Number(value);
}
export function definitionId(value: string): string {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw new DefinitionError(400, '定义 ID 格式错误');
    return value;
}
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
function text(v: unknown, max = 4000): string {
    if (typeof v !== 'string' || !v.trim() || v.length > max) throw new DefinitionError(400, '内容不能为空或超出长度限制');
    return v.trim();
}
export function validateDefinition(v: unknown): BusinessDefinitionContent {
    if (!object(v) || Object.keys(v).some((k) => !['type', 'name', 'description', 'aliases', 'relatedFields', 'metric', 'relationship'].includes(k)))
        throw new DefinitionError(400, '存在不允许的定义字段');
    if (!['metric', 'term', 'relationship'].includes(String(v.type))) throw new DefinitionError(400, '定义类型错误');
    const result: BusinessDefinitionContent = { type: v.type as BusinessDefinitionContent['type'], name: text(v.name, 200), description: text(v.description) };
    for (const key of ['aliases', 'relatedFields'] as const) {
        if (v[key] !== undefined) {
            if (!Array.isArray(v[key]) || v[key].length > 100) throw new DefinitionError(400, '字段列表格式错误');
            result[key] = [...new Set(v[key].map((x) => text(x, 200)))];
        }
    }
    if (v.metric !== undefined) {
        if (
            v.type !== 'metric' ||
            !object(v.metric) ||
            Object.keys(v.metric).some((k) => !['numerator', 'denominator', 'entityGrain', 'timeWindow', 'timezone', 'unit', 'conditions'].includes(k))
        )
            throw new DefinitionError(400, '指标字段错误');
        result.metric = Object.fromEntries(Object.entries(v.metric).map(([k, val]) => [k, text(val)]));
    }
    if (v.type === 'relationship') {
        const r = v.relationship;
        if (
            !object(r) ||
            Object.keys(r).some((k) => !['leftField', 'rightField', 'cardinality', 'explanation'].includes(k)) ||
            !['one-to-one', 'one-to-many', 'many-to-one', 'many-to-many'].includes(String(r.cardinality))
        )
            throw new DefinitionError(400, '请填写完整关系字段');
        result.relationship = {
            leftField: text(r.leftField, 200),
            rightField: text(r.rightField, 200),
            cardinality: r.cardinality as NonNullable<BusinessDefinitionContent['relationship']>['cardinality'],
            explanation: text(r.explanation),
        };
    } else if (v.relationship !== undefined) throw new DefinitionError(400, '此类型不接受关系字段');
    return result;
}
const normalizedName = (name: string) => name.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');
const SELECT = `SELECT d.id, d.datasource_id, d.created_by, d.created_at, d.status AS current_status,
 r.version, r.content, r.status, r.source, r.source_message_id, r.confirmed_by, r.created_at AS updated_at
 FROM business_definition d JOIN business_definition_revision r ON r.definition_id=d.id`;
function record(row: QueryRow, needsReview = false): BusinessDefinition {
    return {
        ...row.content,
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
        needsReview,
    };
}
export class BusinessDefinitionRepository {
    constructor(private readonly db: DatabaseClient) {}
    private async transaction<T>(fn: (s: Session) => Promise<T>): Promise<T> {
        try {
            return await this.db.withTransaction((tx) => fn({ query: async (sql, params) => (await tx.query(sql, params))[0] }));
        } catch (e) {
            if ((e as { code?: string }).code === '23505') throw new DefinitionError(409, '同数据源已存在此名称，请刷新后重试');
            throw e;
        }
    }
    private async authorize(s: Session, ds: number, user: number, write: boolean): Promise<void> {
        const rows = await s.query(
            `SELECT d.id FROM data_source d WHERE d.id=? AND
          ${write ? 'd.created_by=?' : '(d.created_by=? OR d.created_by IS NULL OR EXISTS (SELECT 1 FROM datasource_permission p WHERE p.datasource_id=d.id AND p.user_id=?))'} FOR SHARE OF d`,
            write ? [ds, user] : [ds, user, user]
        );
        if (!rows.length) throw new DefinitionError(404, '数据源或定义不可访问');
    }
    private async fields(s: Session, ds: number): Promise<Set<string>> {
        const rows = await s.query(
            `SELECT c.table_name,c.column_name FROM datasource_table_catalog t
          JOIN information_schema.columns c ON c.table_schema=t.schema_name AND c.table_name=t.table_name
          WHERE t.datasource_id=? AND t.is_agent_visible=TRUE AND t.schema_name=current_schema()`,
            [ds]
        );
        return new Set(rows.map((r) => `${r.table_name}.${r.column_name}`));
    }
    private validFields(content: BusinessDefinitionContent, fields: Set<string>): boolean {
        return [...(content.relatedFields ?? []), ...(content.relationship ? [content.relationship.leftField, content.relationship.rightField] : [])].every((f) => fields.has(f));
    }
    async list(user: number, ds: number, options: { type?: string; q?: string; cursor?: string; limit?: number } = {}) {
        positiveInteger(ds);
        const limit = options.limit === undefined ? 20 : positiveInteger(options.limit);
        if (limit > 100 || (options.type && !['metric', 'term', 'relationship'].includes(options.type))) throw new DefinitionError(400, '分页或类型错误');
        if (options.cursor) definitionId(options.cursor);
        return this.transaction(async (s) => {
            await this.authorize(s, ds, user, false);
            const params: unknown[] = [ds];
            let where = "d.datasource_id=? AND d.status='active' AND r.version=d.version";
            if (options.type) {
                where += " AND r.content->>'type'=?";
                params.push(options.type);
            }
            if (options.q) {
                where += ' AND POSITION(LOWER(?) IN LOWER(r.content::text))>0';
                params.push(options.q);
            }
            if (options.cursor) {
                where += ' AND d.id>?::uuid';
                params.push(options.cursor);
            }
            params.push(limit + 1);
            const rows = await s.query(`${SELECT} WHERE ${where} ORDER BY d.id LIMIT ?`, params);
            const fields = await this.fields(s, ds);
            return {
                items: rows.slice(0, limit).map((r) => record(r, !this.validFields(r.content, fields))),
                nextCursor: rows.length > limit ? (rows[limit - 1].id as string) : null,
            };
        });
    }
    /** One statement observes one revision set. No runtime fixture fallback, no paging across snapshots. */
    async snapshot(user: number, ds: number): Promise<BusinessDefinition[]> {
        return this.transaction(async (s) => {
            await this.authorize(s, ds, user, false);
            const rows = await s.query(`${SELECT} WHERE d.datasource_id=? AND d.status='active' AND r.version=d.version ORDER BY d.id`, [ds]);
            const fields = await this.fields(s, ds);
            return rows.map((r) => record(r, !this.validFields(r.content, fields)));
        });
    }
    async get(user: number, id: string, version?: number): Promise<BusinessDefinition> {
        definitionId(id);
        if (version !== undefined) positiveInteger(version);
        return this.transaction(async (s) => {
            const rows = await s.query(`${SELECT} WHERE d.id=? AND r.version=${version === undefined ? 'd.version' : '?'}`, version === undefined ? [id] : [id, version]);
            if (!rows.length) throw new DefinitionError(404, '定义不存在');
            await this.authorize(s, rows[0].datasource_id, user, false);
            return record(rows[0], !this.validFields(rows[0].content, await this.fields(s, rows[0].datasource_id)));
        });
    }
    private async save(
        s: Session,
        user: number,
        ds: number,
        content: BusinessDefinitionContent,
        id?: string,
        expected?: number,
        sourceMessageId?: string,
        deleted = false
    ): Promise<BusinessDefinition> {
        await this.authorize(s, ds, user, true);
        if (!deleted && !this.validFields(content, await this.fields(s, ds))) throw new DefinitionError(400, '引用字段不属于当前可用数据源，请检查定义');
        let version = 1;
        const status = deleted ? 'deleted' : 'active';
        if (id) {
            const rows = await s.query('SELECT version,status FROM business_definition WHERE id=? AND datasource_id=? FOR UPDATE', [id, ds]);
            if (!rows.length) throw new DefinitionError(404, '定义不存在');
            if (rows[0].version !== expected || rows[0].status !== 'active') throw new DefinitionError(409, '定义已变化，请刷新后重试');
            version = rows[0].version + 1;
            await s.query('UPDATE business_definition SET version=?,status=?,normalized_name=?,updated_at=NOW() WHERE id=?', [version, status, normalizedName(content.name), id]);
        } else {
            const rows = await s.query('INSERT INTO business_definition(datasource_id,version,status,normalized_name,created_by) VALUES (?,1,?,?,?) RETURNING id', [
                ds,
                status,
                normalizedName(content.name),
                user,
            ]);
            id = rows[0].id;
        }
        await s.query('INSERT INTO business_definition_revision(definition_id,version,content,status,source,source_message_id,confirmed_by) VALUES (?,?,?::jsonb,?,?,?,?)', [
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
    /** Explicit owner-authorized one-time import; never invoked by analysis or application startup. */
    async importSaasSeed(user: number, ds: number) {
        positiveInteger(user);
        positiveInteger(ds);
        return this.transaction(async (s) => {
            await this.authorize(s, ds, user, true);
            const catalog = await s.query('SELECT dataset_key FROM datasource_table_catalog WHERE datasource_id=? AND is_agent_visible=TRUE', [ds]);
            if (!catalog.length || catalog.some((t) => t.dataset_key !== 'saas_growth_demo')) throw new DefinitionError(400, '只能导入到 SaaS 演示数据源');
            const receipt = await s.query(
                "INSERT INTO business_definition_seed_import(datasource_id,seed_key,imported_by) VALUES (?,'saas-growth-v1',?) ON CONFLICT DO NOTHING RETURNING datasource_id",
                [ds, user]
            );
            if (!receipt.length) return { imported: false };
            for (const content of SAAS_SEED) await this.save(s, user, ds, content);
            return { imported: true };
        });
    }
    async create(user: number, ds: number, body: unknown) {
        positiveInteger(ds);
        const content = validateDefinition(body);
        return this.transaction((s) => this.save(s, user, ds, content));
    }
    async update(user: number, id: string, expected: number, patch: unknown, deleted = false) {
        definitionId(id);
        positiveInteger(expected);
        if (!object(patch)) throw new DefinitionError(400, '内容格式错误');
        return this.transaction(async (s) => {
            const rows = await s.query(`${SELECT} WHERE d.id=? AND r.version=d.version`, [id]);
            if (!rows.length) throw new DefinitionError(404, '定义不存在');
            const previous = { ...rows[0].content };
            if (patch.type !== undefined && patch.type !== previous.type) {
                delete previous.metric;
                delete previous.relationship;
            }
            const content = deleted ? rows[0].content : validateDefinition({ ...previous, ...patch });
            return this.save(s, user, rows[0].datasource_id, content, id, expected, undefined, deleted);
        });
    }
    /** Drafts are visible only after the owning generation commits completed. */
    async propose(user: number, ds: number, generationId: string, writerToken: string, input: { content: unknown; definitionId?: string; expectedVersion?: number }) {
        const content = validateDefinition(input.content);
        if (input.definitionId) {
            definitionId(input.definitionId);
            positiveInteger(input.expectedVersion);
        } else if (input.expectedVersion !== undefined) throw new DefinitionError(400, '修改候选必须指定定义');
        return this.transaction(async (s) => {
            const generations = await s.query(
                "SELECT request_message_id FROM generation WHERE id=? AND user_id=? AND COALESCE(datasource_id,(SELECT id FROM data_source WHERE is_local=1 ORDER BY id LIMIT 1))=? AND writer_token=? AND status IN ('starting','running') FOR UPDATE",
                [generationId, user, ds, writerToken]
            );
            if (!generations.length) throw new DefinitionError(409, '任务已停止或写入凭证失效');
            await this.authorize(s, ds, user, true);
            if (!this.validFields(content, await this.fields(s, ds))) throw new DefinitionError(400, '候选引用字段无效');
            if (input.definitionId) {
                const target = await s.query("SELECT version FROM business_definition WHERE id=? AND datasource_id=? AND status='active'", [input.definitionId, ds]);
                if (!target.length) throw new DefinitionError(404, '目标定义不可访问');
                if (target[0].version !== input.expectedVersion) throw new DefinitionError(409, '目标定义已变化');
            }
            const count = await s.query('SELECT COUNT(*)::int AS count FROM business_definition_candidate WHERE generation_id=?', [generationId]);
            if (count[0].count >= 10) throw new DefinitionError(409, '本轮候选已达上限');
            const rows = await s.query(
                `INSERT INTO business_definition_candidate(datasource_id,user_id,generation_id,source_message_id,definition_id,expected_version,content)
             VALUES (?,?,?,?,?,?,?::jsonb) RETURNING id`,
                [ds, user, generationId, generations[0].request_message_id, input.definitionId ?? null, input.expectedVersion ?? null, JSON.stringify(content)]
            );
            return { candidateId: rows[0].id, status: 'draft', message: '任务成功后可在业务定义页面确认；尚未保存为正式定义' };
        });
    }
    async candidates(user: number, ds: number, conversationId?: string): Promise<BusinessDefinitionCandidate[]> {
        positiveInteger(ds);
        if (conversationId) definitionId(conversationId);
        return this.transaction(async (s) => {
            await this.authorize(s, ds, user, true);
            const rows = await s.query(
                `SELECT c.* FROM business_definition_candidate c JOIN generation g ON g.id=c.generation_id
             WHERE c.datasource_id=? AND c.user_id=? AND c.status='pending' AND g.status='completed'
             ${conversationId ? 'AND g.conversation_id=?' : ''} ORDER BY c.created_at,c.id`,
                conversationId ? [ds, user, conversationId] : [ds, user]
            );
            return rows.map((c) => ({
                id: c.id,
                datasourceId: c.datasource_id,
                version: c.version,
                content: c.content,
                definitionId: c.definition_id,
                expectedVersion: c.expected_version,
                sourceMessageId: c.source_message_id,
                generationId: c.generation_id,
                status: c.status,
            }));
        });
    }
    async decide(user: number, id: string, expected: number, accept: boolean) {
        definitionId(id);
        positiveInteger(expected);
        return this.transaction(async (s) => {
            const rows = await s.query(
                `SELECT c.* FROM business_definition_candidate c JOIN generation g ON g.id=c.generation_id
             WHERE c.id=? AND c.user_id=? AND g.status='completed' FOR UPDATE OF c`,
                [id, user]
            );
            if (!rows.length) throw new DefinitionError(404, '候选不可访问');
            const c = rows[0];
            await this.authorize(s, c.datasource_id, user, true);
            if (c.status === (accept ? 'accepted' : 'rejected') && expected === c.version - 1)
                return { status: c.status, definitionId: c.result_definition_id, version: c.result_version };
            if (c.status !== 'pending' || c.version !== expected) throw new DefinitionError(409, '候选已变化，请刷新后重试');
            const result = accept
                ? await this.save(s, user, c.datasource_id, validateDefinition(c.content), c.definition_id ?? undefined, c.expected_version ?? undefined, c.source_message_id)
                : null;
            await s.query('UPDATE business_definition_candidate SET status=?,version=version+1,result_definition_id=?,result_version=? WHERE id=?', [
                accept ? 'accepted' : 'rejected',
                result?.id ?? null,
                result?.version ?? null,
                id,
            ]);
            return { status: accept ? 'accepted' : 'rejected', definitionId: result?.id ?? null, version: result?.version ?? null };
        });
    }
}

const SAAS_SEED: BusinessDefinitionContent[] = [
    {
        type: 'metric',
        name: '7 日激活率',
        description: '用户粒度。分子是 activated_at <= signup_at + interval 7 days 的注册用户；分母排除截至观察截止时间尚未满 7 天的注册用户。时区 UTC。',
        relatedFields: ['product_users.signup_at', 'product_users.activated_at'],
    },
    { type: 'metric', name: 'DAU', description: 'UTC 自然日内至少产生一个事件的去重 user_id 数量。缺失采集不代表真实活跃为零。', relatedFields: ['product_events.user_id'] },
];
