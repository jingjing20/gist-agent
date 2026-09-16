interface Queryable {
    query(sql: string, values?: unknown[]): Promise<unknown>;
}

interface DemoDataOptions {
    now?: Date;
    random?: () => number;
}

type SeedRow = Record<string, unknown>;

const DAY_MS = 24 * 60 * 60 * 1000;
const DATASET_KEY = 'saas_growth_demo';
export const DEMO_DATA_ANCHOR_DATE = '2026-09-15T00:00:00.000Z';

const CAMPAIGNS = [
    { id: 1, name: '品牌词常青计划', channel: 'paid_search', objective: 'conversion', budget: 180000, start_date: '2025-01-01', end_date: null },
    { id: 2, name: '内容增长引擎', channel: 'content', objective: 'signup', budget: 90000, start_date: '2025-01-01', end_date: null },
    { id: 3, name: '合作伙伴加速器', channel: 'partner', objective: 'enterprise_pipeline', budget: 260000, start_date: '2025-02-01', end_date: null },
    { id: 4, name: '春季效率峰会', channel: 'event', objective: 'lead_generation', budget: 320000, start_date: '2025-03-01', end_date: '2025-05-31' },
    { id: 5, name: '夏日扩张', channel: 'paid_social', objective: 'signup', budget: 420000, start_date: '2025-06-01', end_date: '2025-08-31' },
    { id: 6, name: '客户推荐计划', channel: 'referral', objective: 'conversion', budget: 70000, start_date: '2025-01-15', end_date: null },
    { id: 7, name: '亚太增长实验', channel: 'paid_social', objective: 'signup', budget: 210000, start_date: '2025-07-01', end_date: '2025-09-30' },
    { id: 8, name: '企业 ABM 计划', channel: 'outbound', objective: 'enterprise_pipeline', budget: 500000, start_date: '2025-04-01', end_date: null },
];

const RELEASES = [
    { id: 1, version: '3.1.0', release_offset: 110, feature_area: 'dashboard', release_type: 'feature', incident_severity: null, notes: '新版可视化编辑器' },
    { id: 2, version: '3.2.0', release_offset: 88, feature_area: 'connector', release_type: 'feature', incident_severity: null, notes: '新增数据源连接向导' },
    { id: 3, version: '3.3.0', release_offset: 67, feature_area: 'collaboration', release_type: 'feature', incident_severity: null, notes: '团队评论与分享' },
    { id: 4, version: '3.4.0', release_offset: 45, feature_area: 'ai_search', release_type: 'major', incident_severity: 'SEV2', notes: 'AI 搜索上线；导出服务出现兼容性故障' },
    { id: 5, version: '3.4.1', release_offset: 39, feature_area: 'export', release_type: 'hotfix', incident_severity: null, notes: '修复导出兼容性问题' },
    { id: 6, version: '3.5.0', release_offset: 18, feature_area: 'automation', release_type: 'feature', incident_severity: null, notes: '自动化报告与定时任务' },
];

const TABLE_CATALOG = [
    ['marketing_campaigns', '营销活动', '营销活动投入、渠道和目标，用于获客归因与渠道 ROI 分析'],
    ['product_releases', '产品发布记录', '产品版本、功能范围和发布事故记录，用于事件影响分析'],
    ['customer_accounts', '客户账户', 'B2B 客户账户维度；一个账户包含多个产品用户'],
    ['product_users', '产品用户', '产品用户、注册来源和画像维度；激活定义见字段注释'],
    ['subscriptions', '订阅历史', '账户订阅周期及 MRR；同一账户可能有多段订阅历史'],
    ['invoices', '账单与回款', '订阅账单、折扣、实收、退款和支付状态'],
    ['experiment_assignments', '实验分组', 'onboarding_flow_v2 实验的用户随机分组记录'],
    ['product_events', '产品行为事件', '用户行为明细；包含可通过业务键识别的少量重复和局部采集缺口'],
    ['support_tickets', '客服工单', '客户问题、响应解决时长和满意度，用于体验与留存关联分析'],
    ['daily_business_metrics', '每日经营指标', '按日汇总的管理口径指标，可与明细表进行口径和数据质量核对'],
] as const;

function seededRandom(seed = 20260915): () => number {
    let state = seed >>> 0;
    return () => {
        state += 0x6d2b79f5;
        let value = state;
        value = Math.imul(value ^ (value >>> 15), value | 1);
        value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
        return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };
}

function pick<T>(values: readonly T[], random: () => number): T {
    return values[Math.floor(random() * values.length)];
}

function isoDate(timestamp: number): string {
    return new Date(timestamp).toISOString().slice(0, 10);
}

function isoTime(timestamp: number): string {
    return new Date(timestamp).toISOString();
}

async function insertJsonRows(db: Queryable, tableName: string, columnDefinitions: string, rows: SeedRow[]): Promise<void> {
    const columnNames = columnDefinitions
        .split(',')
        .map((definition) => definition.trim().split(/\s+/)[0])
        .join(', ');
    await db.query(
        `INSERT INTO ${tableName} (${columnNames})
         SELECT ${columnNames}
         FROM jsonb_to_recordset($1::jsonb) AS seed(${columnDefinitions})
         WHERE NOT EXISTS (SELECT 1 FROM ${tableName})`,
        [JSON.stringify(rows)]
    );
}

/** A reproducible B2B SaaS dataset for product, growth, revenue and data-quality analysis. */
export async function initializeDemoData(db: Queryable, options: DemoDataOptions = {}): Promise<void> {
    const now = options.now ?? new Date(DEMO_DATA_ANCHOR_DATE);
    const random = options.random ?? seededRandom();
    const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());

    await db.query('BEGIN');
    try {
        await db.query(`
          DELETE FROM datasource_table_catalog WHERE dataset_key = 'basic_platform_demo';
          DROP TABLE IF EXISTS user_behavior_log;
          DROP TABLE IF EXISTS daily_active_stats;
          DROP TABLE IF EXISTS platform_info;

          CREATE TABLE IF NOT EXISTS marketing_campaigns (
            id INTEGER PRIMARY KEY, name VARCHAR(100) NOT NULL, channel VARCHAR(30) NOT NULL,
            objective VARCHAR(40) NOT NULL, budget NUMERIC(12,2) NOT NULL,
            start_date DATE NOT NULL, end_date DATE
          );
          COMMENT ON TABLE marketing_campaigns IS '营销活动维表';
          COMMENT ON COLUMN marketing_campaigns.channel IS '归因渠道: paid_search/content/partner/event/paid_social/referral/outbound';
          COMMENT ON COLUMN marketing_campaigns.budget IS '活动预算，人民币元';

          CREATE TABLE IF NOT EXISTS product_releases (
            id INTEGER PRIMARY KEY, version VARCHAR(20) NOT NULL UNIQUE, released_at TIMESTAMPTZ NOT NULL,
            feature_area VARCHAR(40) NOT NULL, release_type VARCHAR(20) NOT NULL,
            incident_severity VARCHAR(10), notes TEXT
          );
          COMMENT ON TABLE product_releases IS '产品版本与发布事件；用于版本前后影响和事故分析';
          COMMENT ON COLUMN product_releases.incident_severity IS '发布关联事故级别；NULL 表示无已知事故';

          CREATE TABLE IF NOT EXISTS customer_accounts (
            id INTEGER PRIMARY KEY, account_name VARCHAR(100) NOT NULL, industry VARCHAR(40) NOT NULL,
            segment VARCHAR(20) NOT NULL, region VARCHAR(20), employee_count INTEGER NOT NULL,
            acquisition_channel VARCHAR(30) NOT NULL, campaign_id INTEGER REFERENCES marketing_campaigns(id),
            created_at TIMESTAMPTZ NOT NULL
          );
          COMMENT ON TABLE customer_accounts IS 'B2B 客户账户维表；分析粒度为企业账户';
          COMMENT ON COLUMN customer_accounts.segment IS '客户分层: smb/mid_market/enterprise';
          COMMENT ON COLUMN customer_accounts.region IS '销售区域；少量 NULL 用于数据完整性检查';
          COMMENT ON COLUMN customer_accounts.campaign_id IS '末次触达营销活动；自然流量为 NULL';

          CREATE TABLE IF NOT EXISTS product_users (
            id INTEGER PRIMARY KEY, account_id INTEGER NOT NULL REFERENCES customer_accounts(id),
            signup_at TIMESTAMPTZ NOT NULL, role VARCHAR(30) NOT NULL, country VARCHAR(30) NOT NULL,
            device_type VARCHAR(20) NOT NULL, acquisition_channel VARCHAR(30) NOT NULL,
            campaign_id INTEGER REFERENCES marketing_campaigns(id), activated_at TIMESTAMPTZ,
            status VARCHAR(20) NOT NULL
          );
          COMMENT ON TABLE product_users IS '产品用户维表；一个账户包含多个用户';
          COMMENT ON COLUMN product_users.activated_at IS '首次完成数据连接并执行查询的时间；注册后 7 天内完成视为 7 日激活';
          COMMENT ON COLUMN product_users.status IS '用户状态: active/inactive/deleted';

          CREATE TABLE IF NOT EXISTS subscriptions (
            id INTEGER PRIMARY KEY, account_id INTEGER NOT NULL REFERENCES customer_accounts(id),
            plan_name VARCHAR(20) NOT NULL, billing_cycle VARCHAR(10) NOT NULL,
            started_at DATE NOT NULL, ended_at DATE, status VARCHAR(20) NOT NULL,
            seats INTEGER NOT NULL, monthly_recurring_revenue NUMERIC(12,2) NOT NULL,
            cancellation_reason VARCHAR(60)
          );
          COMMENT ON TABLE subscriptions IS '账户订阅历史；同一账户可能先试用再付费或产生续订记录';
          COMMENT ON COLUMN subscriptions.monthly_recurring_revenue IS '标准化月度经常性收入 MRR，人民币元；trial/free 为 0';
          COMMENT ON COLUMN subscriptions.status IS '订阅状态: trial/active/cancelled/expired';

          CREATE TABLE IF NOT EXISTS invoices (
            id INTEGER PRIMARY KEY, subscription_id INTEGER NOT NULL REFERENCES subscriptions(id),
            account_id INTEGER NOT NULL REFERENCES customer_accounts(id), invoice_date DATE NOT NULL,
            due_date DATE NOT NULL, paid_at TIMESTAMPTZ, status VARCHAR(20) NOT NULL,
            gross_amount NUMERIC(12,2) NOT NULL, discount_amount NUMERIC(12,2) NOT NULL,
            tax_amount NUMERIC(12,2) NOT NULL, paid_amount NUMERIC(12,2) NOT NULL,
            refunded_amount NUMERIC(12,2) NOT NULL
          );
          COMMENT ON TABLE invoices IS '订阅账单事实表；金额单位均为人民币元';
          COMMENT ON COLUMN invoices.status IS '账单状态: paid/open/overdue/refunded';
          COMMENT ON COLUMN invoices.paid_amount IS '实际到账金额，退款另记在 refunded_amount';

          CREATE TABLE IF NOT EXISTS experiment_assignments (
            id INTEGER PRIMARY KEY, experiment_key VARCHAR(50) NOT NULL,
            user_id INTEGER NOT NULL REFERENCES product_users(id), variant VARCHAR(20) NOT NULL,
            assigned_at TIMESTAMPTZ NOT NULL, exposure_at TIMESTAMPTZ,
            UNIQUE(experiment_key, user_id)
          );
          COMMENT ON TABLE experiment_assignments IS '产品实验随机分组；实验结果需结合行为和用户激活指标分析';
          COMMENT ON COLUMN experiment_assignments.variant IS '实验版本: control/guided';
          COMMENT ON COLUMN experiment_assignments.exposure_at IS '用户首次真正看到实验体验的时间；未曝光用户为 NULL';

          CREATE TABLE IF NOT EXISTS product_events (
            id BIGINT PRIMARY KEY, event_uuid VARCHAR(50) NOT NULL UNIQUE,
            event_time TIMESTAMPTZ NOT NULL, ingested_at TIMESTAMPTZ NOT NULL,
            account_id INTEGER NOT NULL REFERENCES customer_accounts(id),
            user_id INTEGER NOT NULL REFERENCES product_users(id), session_id VARCHAR(50) NOT NULL,
            event_name VARCHAR(40) NOT NULL, feature_area VARCHAR(40) NOT NULL,
            device_type VARCHAR(20) NOT NULL, app_version VARCHAR(20) NOT NULL,
            properties JSONB NOT NULL DEFAULT '{}'
          );
          COMMENT ON TABLE product_events IS '产品行为事件明细；存在少量业务键重复、延迟入仓及 APAC Android 局部采集缺口';
          COMMENT ON COLUMN product_events.event_uuid IS '采集事件唯一 ID；逻辑重复需按用户、会话、事件名和事件时间识别';
          COMMENT ON COLUMN product_events.ingested_at IS '入仓时间，可与 event_time 比较识别延迟数据';
          COMMENT ON COLUMN product_events.event_name IS '事件名，包括 signup/login/connect_data/run_query/create_dashboard/search/export_success/export_failed/invite_member/automation_run';
          CREATE INDEX IF NOT EXISTS idx_product_events_time ON product_events(event_time);
          CREATE INDEX IF NOT EXISTS idx_product_events_user_time ON product_events(user_id, event_time);
          CREATE INDEX IF NOT EXISTS idx_product_events_account_time ON product_events(account_id, event_time);

          CREATE TABLE IF NOT EXISTS support_tickets (
            id INTEGER PRIMARY KEY, account_id INTEGER NOT NULL REFERENCES customer_accounts(id),
            requester_user_id INTEGER REFERENCES product_users(id), opened_at TIMESTAMPTZ NOT NULL,
            first_response_at TIMESTAMPTZ, resolved_at TIMESTAMPTZ,
            priority VARCHAR(10) NOT NULL, category VARCHAR(40) NOT NULL,
            status VARCHAR(20) NOT NULL, channel VARCHAR(20) NOT NULL,
            csat_score INTEGER, related_version VARCHAR(20)
          );
          COMMENT ON TABLE support_tickets IS '客服工单事实表；可分析版本事故、响应 SLA、满意度和续费流失关联';
          COMMENT ON COLUMN support_tickets.csat_score IS '客户满意度 1-5；未解决或未评价为 NULL';

          CREATE TABLE IF NOT EXISTS daily_business_metrics (
            metric_date DATE PRIMARY KEY, signups INTEGER NOT NULL, activated_users INTEGER NOT NULL,
            active_users INTEGER NOT NULL, trial_starts INTEGER NOT NULL, paid_conversions INTEGER NOT NULL,
            ending_mrr NUMERIC(14,2) NOT NULL, churned_mrr NUMERIC(14,2) NOT NULL,
            support_tickets INTEGER NOT NULL, source_updated_at TIMESTAMPTZ NOT NULL
          );
          COMMENT ON TABLE daily_business_metrics IS '管理层每日经营汇总；应与明细事实表核对，个别日期存在模拟口径偏差';
          COMMENT ON COLUMN daily_business_metrics.metric_date IS 'UTC 自然日，与 product_events.event_time 按 UTC 日期聚合后关联';
          COMMENT ON COLUMN daily_business_metrics.active_users IS '管理口径 DAU：当日至少一个有效产品事件的去重用户数';
          COMMENT ON COLUMN daily_business_metrics.ending_mrr IS '截至当日仍有效的 active 订阅 MRR 合计';
        `);

        const releaseRows: SeedRow[] = RELEASES.map((release) => ({
            id: release.id,
            version: release.version,
            released_at: isoTime(todayUtc - release.release_offset * DAY_MS + 10 * 60 * 60 * 1000),
            feature_area: release.feature_area,
            release_type: release.release_type,
            incident_severity: release.incident_severity,
            notes: release.notes,
        }));

        await insertJsonRows(db, 'marketing_campaigns', 'id integer, name text, channel text, objective text, budget numeric, start_date date, end_date date', CAMPAIGNS);
        await insertJsonRows(
            db,
            'product_releases',
            'id integer, version text, released_at timestamptz, feature_area text, release_type text, incident_severity text, notes text',
            releaseRows
        );

        const accountRows: SeedRow[] = [];
        const userRows: SeedRow[] = [];
        const subscriptionRows: SeedRow[] = [];
        const assignmentRows: SeedRow[] = [];
        const channels = ['organic', 'paid_search', 'content', 'partner', 'event', 'paid_social', 'referral', 'outbound'] as const;
        const campaignByChannel = new Map(CAMPAIGNS.map((campaign) => [campaign.channel, campaign.id]));
        const industries = ['software', 'retail', 'manufacturing', 'finance', 'education', 'healthcare'];
        const regions = ['north_china', 'east_china', 'south_china', 'west_china', 'apac'];
        const roles = ['owner', 'admin', 'analyst', 'viewer'];
        const countriesByRegion: Record<string, string[]> = {
            north_china: ['CN-BJ', 'CN-TJ'],
            east_china: ['CN-SH', 'CN-ZJ', 'CN-JS'],
            south_china: ['CN-GD', 'CN-FJ'],
            west_china: ['CN-SC', 'CN-CQ'],
            apac: ['SG', 'JP', 'AU'],
        };
        let userId = 1;
        let subscriptionId = 1;
        let assignmentId = 1;
        const userMeta = new Map<
            number,
            { accountId: number; signupTime: number; region: string | null; device: string; channel: string; activatedAt: number | null; status: string }
        >();
        const accountMeta = new Map<number, { segment: string; status: string }>();

        for (let accountId = 1; accountId <= 300; accountId++) {
            const segment = accountId % 15 === 0 ? 'enterprise' : accountId % 4 === 0 ? 'mid_market' : 'smb';
            const channel = pick(channels, random);
            const regionValue = accountId % 73 === 0 ? null : pick(regions, random);
            const createdDaysAgo = 30 + Math.floor(random() * 330);
            const createdTime = todayUtc - createdDaysAgo * DAY_MS + Math.floor(random() * 12) * 60 * 60 * 1000;
            const campaignId = channel === 'organic' ? null : (campaignByChannel.get(channel) ?? null);
            const employeeBase = segment === 'enterprise' ? 1200 : segment === 'mid_market' ? 260 : 45;
            accountRows.push({
                id: accountId,
                account_name: `示例客户-${String(accountId).padStart(3, '0')}`,
                industry: pick(industries, random),
                segment,
                region: regionValue,
                employee_count: Math.round(employeeBase * (0.6 + random() * 1.2)),
                acquisition_channel: channel,
                campaign_id: campaignId,
                created_at: isoTime(createdTime),
            });

            const conversionRate = channel === 'referral' || channel === 'partner' ? 0.82 : channel === 'paid_social' ? 0.42 : 0.64;
            const isPaid = random() < conversionRate;
            const isCancelled = isPaid && random() < (segment === 'smb' ? 0.2 : 0.08);
            const planName = segment === 'enterprise' ? 'enterprise' : segment === 'mid_market' ? 'team' : isPaid ? 'starter' : 'trial';
            const mrr = isPaid
                ? segment === 'enterprise'
                    ? 18000 + Math.round(random() * 12000)
                    : segment === 'mid_market'
                      ? 4500 + Math.round(random() * 3500)
                      : 699 + Math.round(random() * 600)
                : 0;
            const subscriptionStart = createdTime + (3 + Math.floor(random() * 18)) * DAY_MS;
            const endedTime = isCancelled ? subscriptionStart + (35 + Math.floor(random() * 150)) * DAY_MS : null;
            const effectiveEndedTime = endedTime && endedTime < todayUtc ? endedTime : null;
            const status = !isPaid ? 'expired' : effectiveEndedTime ? 'cancelled' : 'active';
            subscriptionRows.push({
                id: subscriptionId++,
                account_id: accountId,
                plan_name: planName,
                billing_cycle: segment === 'enterprise' || random() < 0.35 ? 'annual' : 'monthly',
                started_at: isoDate(subscriptionStart),
                ended_at: effectiveEndedTime ? isoDate(effectiveEndedTime) : null,
                status,
                seats: segment === 'enterprise' ? 100 + Math.floor(random() * 200) : segment === 'mid_market' ? 25 + Math.floor(random() * 55) : 3 + Math.floor(random() * 15),
                monthly_recurring_revenue: mrr,
                cancellation_reason: status === 'cancelled' ? pick(['low_usage', 'missing_features', 'price', 'poor_support', 'company_closed'], random) : null,
            });
            accountMeta.set(accountId, { segment, status });

            const usersPerAccount = segment === 'enterprise' ? 12 : segment === 'mid_market' ? 7 : 4;
            for (let member = 0; member < usersPerAccount; member++) {
                const id = userId++;
                const signupTime = createdTime + Math.floor(random() * 14) * DAY_MS + Math.floor(random() * 18) * 60 * 60 * 1000;
                const device = random() < 0.68 ? 'web' : random() < 0.55 ? 'ios' : 'android';
                const guided = id % 2 === 0;
                const activationRate = 0.58 + (channel === 'paid_social' ? -0.18 : channel === 'referral' ? 0.14 : 0) + (guided ? 0.11 : 0) + (segment === 'enterprise' ? 0.08 : 0);
                const activatedAt = random() < activationRate ? signupTime + (1 + Math.floor(random() * 9)) * DAY_MS : null;
                const userStatus = status === 'cancelled' && random() < 0.75 ? 'inactive' : random() < 0.04 ? 'deleted' : 'active';
                userRows.push({
                    id,
                    account_id: accountId,
                    signup_at: isoTime(signupTime),
                    role: member === 0 ? 'owner' : pick(roles, random),
                    country: pick(countriesByRegion[regionValue ?? 'east_china'], random),
                    device_type: device,
                    acquisition_channel: channel,
                    campaign_id: campaignId,
                    activated_at: activatedAt ? isoTime(activatedAt) : null,
                    status: userStatus,
                });
                userMeta.set(id, { accountId, signupTime, region: regionValue, device, channel, activatedAt, status: userStatus });

                const experimentStart = todayUtc - 75 * DAY_MS;
                if (signupTime >= experimentStart && signupTime <= todayUtc - 8 * DAY_MS) {
                    assignmentRows.push({
                        id: assignmentId++,
                        experiment_key: 'onboarding_flow_v2',
                        user_id: id,
                        variant: guided ? 'guided' : 'control',
                        assigned_at: isoTime(signupTime),
                        exposure_at: random() < 0.9 ? isoTime(signupTime + Math.floor(random() * 6) * 60 * 60 * 1000) : null,
                    });
                }
            }
        }

        await insertJsonRows(
            db,
            'customer_accounts',
            'id integer, account_name text, industry text, segment text, region text, employee_count integer, acquisition_channel text, campaign_id integer, created_at timestamptz',
            accountRows
        );
        await insertJsonRows(
            db,
            'product_users',
            'id integer, account_id integer, signup_at timestamptz, role text, country text, device_type text, acquisition_channel text, campaign_id integer, activated_at timestamptz, status text',
            userRows
        );
        await insertJsonRows(
            db,
            'subscriptions',
            'id integer, account_id integer, plan_name text, billing_cycle text, started_at date, ended_at date, status text, seats integer, monthly_recurring_revenue numeric, cancellation_reason text',
            subscriptionRows
        );
        await insertJsonRows(
            db,
            'experiment_assignments',
            'id integer, experiment_key text, user_id integer, variant text, assigned_at timestamptz, exposure_at timestamptz',
            assignmentRows
        );

        const eventRows: SeedRow[] = [];
        let eventId = 1;
        const addEvent = (user: number, timestamp: number, eventName: string, featureArea: string, sessionId: string, properties: SeedRow = {}) => {
            const meta = userMeta.get(user)!;
            const daysAgo = Math.floor((todayUtc - timestamp) / DAY_MS);
            const version = daysAgo > 88 ? '3.1.0' : daysAgo > 67 ? '3.2.0' : daysAgo > 45 ? '3.3.0' : daysAgo > 39 ? '3.4.0' : daysAgo > 18 ? '3.4.1' : '3.5.0';
            const ingestionDelay = random() < 0.025 ? (2 + Math.floor(random() * 5)) * DAY_MS : Math.floor(random() * 45) * 60 * 1000;
            const row: SeedRow = {
                id: eventId,
                event_uuid: `evt-${String(eventId).padStart(8, '0')}`,
                event_time: isoTime(timestamp),
                ingested_at: isoTime(timestamp + ingestionDelay),
                account_id: meta.accountId,
                user_id: user,
                session_id: sessionId,
                event_name: eventName,
                feature_area: featureArea,
                device_type: meta.device,
                app_version: version,
                properties,
            };
            eventRows.push(row);
            eventId++;
            if (random() < 0.006) {
                eventRows.push({ ...row, id: eventId, event_uuid: `evt-${String(eventId).padStart(8, '0')}` });
                eventId++;
            }
        };

        for (const [id, meta] of userMeta) {
            if (meta.signupTime > todayUtc) continue;
            const session = `s-${id}-signup`;
            addEvent(id, meta.signupTime, 'signup', 'onboarding', session, { channel: meta.channel });
            if (meta.activatedAt) {
                addEvent(id, meta.signupTime + 4 * 60 * 60 * 1000, 'create_workspace', 'onboarding', session);
                addEvent(id, meta.activatedAt - 30 * 60 * 1000, 'connect_data', 'connector', session);
                addEvent(id, meta.activatedAt, 'run_query', 'analysis', session);
            }
        }

        for (let daysAgo = 119; daysAgo >= 0; daysAgo--) {
            const dayStart = todayUtc - daysAgo * DAY_MS;
            const weekday = new Date(dayStart).getUTCDay();
            const weekend = weekday === 0 || weekday === 6;
            for (const [id, meta] of userMeta) {
                if (meta.signupTime > dayStart + DAY_MS || meta.status !== 'active') continue;
                const account = accountMeta.get(meta.accountId)!;
                const baseActivity = account.segment === 'enterprise' ? 0.19 : account.segment === 'mid_market' ? 0.13 : 0.085;
                const activityProbability =
                    baseActivity * (meta.activatedAt ? 1.55 : 0.42) * (account.status === 'cancelled' ? 0.32 : 1) * (weekend ? (account.segment === 'enterprise' ? 0.5 : 0.7) : 1);
                if (random() >= activityProbability) continue;
                if (meta.region === 'apac' && meta.device === 'android' && daysAgo >= 32 && daysAgo <= 34) continue;

                const session = `s-${id}-${isoDate(dayStart)}-${Math.floor(random() * 3)}`;
                const firstTime = dayStart + (8 + Math.floor(random() * 12)) * 60 * 60 * 1000 + Math.floor(random() * 45) * 60 * 1000;
                addEvent(id, firstTime, 'login', 'core', session);
                addEvent(id, firstTime + 3 * 60 * 1000, 'run_query', 'analysis', session, { query_type: pick(['sql', 'natural_language', 'template'], random) });
                if (random() < 0.34) addEvent(id, firstTime + 7 * 60 * 1000, 'create_dashboard', 'dashboard', session);
                if (daysAgo <= 45 && random() < 0.48) addEvent(id, firstTime + 9 * 60 * 1000, 'search', 'ai_search', session);
                if (random() < 0.22) {
                    const failed = daysAgo >= 40 && daysAgo <= 45 && random() < 0.42;
                    addEvent(id, firstTime + 12 * 60 * 1000, failed ? 'export_failed' : 'export_success', 'export', session, { format: pick(['csv', 'xlsx', 'pdf'], random) });
                }
                if (account.segment !== 'smb' && random() < 0.11) addEvent(id, firstTime + 15 * 60 * 1000, 'invite_member', 'collaboration', session);
                if (daysAgo <= 18 && random() < 0.16) addEvent(id, firstTime + 18 * 60 * 1000, 'automation_run', 'automation', session);
            }
        }
        await insertJsonRows(
            db,
            'product_events',
            'id bigint, event_uuid text, event_time timestamptz, ingested_at timestamptz, account_id integer, user_id integer, session_id text, event_name text, feature_area text, device_type text, app_version text, properties jsonb',
            eventRows
        );

        const invoiceRows: SeedRow[] = [];
        let invoiceId = 1;
        for (const subscription of subscriptionRows) {
            if (Number(subscription.monthly_recurring_revenue) === 0) continue;
            const startTime = Date.parse(String(subscription.started_at));
            const endTime = subscription.ended_at ? Date.parse(String(subscription.ended_at)) : todayUtc;
            let invoiceTime = Date.UTC(new Date(startTime).getUTCFullYear(), new Date(startTime).getUTCMonth(), 1);
            while (invoiceTime <= Math.min(endTime, todayUtc)) {
                const overdue = random() < 0.07;
                const refunded = !overdue && random() < 0.025;
                const gross = Number(subscription.monthly_recurring_revenue);
                const discount = random() < 0.18 ? Math.round(gross * 0.1) : 0;
                const tax = Math.round((gross - discount) * 0.06 * 100) / 100;
                const net = gross - discount + tax;
                invoiceRows.push({
                    id: invoiceId++,
                    subscription_id: subscription.id,
                    account_id: subscription.account_id,
                    invoice_date: isoDate(invoiceTime),
                    due_date: isoDate(invoiceTime + 15 * DAY_MS),
                    paid_at: overdue ? null : isoTime(invoiceTime + (2 + Math.floor(random() * 12)) * DAY_MS),
                    status: overdue ? 'overdue' : refunded ? 'refunded' : 'paid',
                    gross_amount: gross,
                    discount_amount: discount,
                    tax_amount: tax,
                    paid_amount: overdue ? 0 : net,
                    refunded_amount: refunded ? net : 0,
                });
                invoiceTime = Date.UTC(new Date(invoiceTime).getUTCFullYear(), new Date(invoiceTime).getUTCMonth() + 1, 1);
            }
        }
        await insertJsonRows(
            db,
            'invoices',
            'id integer, subscription_id integer, account_id integer, invoice_date date, due_date date, paid_at timestamptz, status text, gross_amount numeric, discount_amount numeric, tax_amount numeric, paid_amount numeric, refunded_amount numeric',
            invoiceRows
        );

        const ticketRows: SeedRow[] = [];
        let ticketId = 1;
        const usersByAccount = new Map<number, number[]>();
        for (const [id, meta] of userMeta) usersByAccount.set(meta.accountId, [...(usersByAccount.get(meta.accountId) ?? []), id]);
        for (let daysAgo = 119; daysAgo >= 0; daysAgo--) {
            const dayStart = todayUtc - daysAgo * DAY_MS;
            const incident = daysAgo >= 40 && daysAgo <= 45;
            const count = 2 + Math.floor(random() * 4) + (incident ? 11 : 0);
            for (let index = 0; index < count; index++) {
                const accountId = 1 + Math.floor(random() * accountRows.length);
                const requester = pick(usersByAccount.get(accountId)!, random);
                const openedAt = dayStart + (8 + Math.floor(random() * 12)) * 60 * 60 * 1000;
                const priority = incident && random() < 0.55 ? 'high' : pick(['low', 'medium', 'medium', 'high'], random);
                const responseHours = priority === 'high' ? 1 + Math.floor(random() * 5) : 3 + Math.floor(random() * 20);
                const unresolved = random() < 0.08;
                const resolveHours = responseHours + 4 + Math.floor(random() * (incident ? 48 : 30));
                ticketRows.push({
                    id: ticketId++,
                    account_id: accountId,
                    requester_user_id: requester,
                    opened_at: isoTime(openedAt),
                    first_response_at: isoTime(openedAt + responseHours * 60 * 60 * 1000),
                    resolved_at: unresolved ? null : isoTime(openedAt + resolveHours * 60 * 60 * 1000),
                    priority,
                    category: incident ? 'export_failure' : pick(['how_to', 'billing', 'connector', 'performance', 'feature_request'], random),
                    status: unresolved ? 'open' : 'resolved',
                    channel: pick(['email', 'chat', 'web'], random),
                    csat_score: unresolved ? null : incident ? 1 + Math.floor(random() * 3) : 3 + Math.floor(random() * 3),
                    related_version: incident ? '3.4.0' : null,
                });
            }
        }
        await insertJsonRows(
            db,
            'support_tickets',
            'id integer, account_id integer, requester_user_id integer, opened_at timestamptz, first_response_at timestamptz, resolved_at timestamptz, priority text, category text, status text, channel text, csat_score integer, related_version text',
            ticketRows
        );

        const eventDateUsers = new Map<string, Set<number>>();
        const signupCounts = new Map<string, number>();
        const activationCounts = new Map<string, number>();
        const ticketCounts = new Map<string, number>();
        for (const event of eventRows) {
            const date = String(event.event_time).slice(0, 10);
            if (!eventDateUsers.has(date)) eventDateUsers.set(date, new Set());
            eventDateUsers.get(date)!.add(Number(event.user_id));
        }
        for (const user of userRows) {
            const signupDate = String(user.signup_at).slice(0, 10);
            signupCounts.set(signupDate, (signupCounts.get(signupDate) ?? 0) + 1);
            if (user.activated_at) {
                const activationDate = String(user.activated_at).slice(0, 10);
                activationCounts.set(activationDate, (activationCounts.get(activationDate) ?? 0) + 1);
            }
        }
        for (const ticket of ticketRows) {
            const date = String(ticket.opened_at).slice(0, 10);
            ticketCounts.set(date, (ticketCounts.get(date) ?? 0) + 1);
        }

        const metricRows: SeedRow[] = [];
        for (let daysAgo = 119; daysAgo >= 0; daysAgo--) {
            const timestamp = todayUtc - daysAgo * DAY_MS;
            const date = isoDate(timestamp);
            let endingMrr = 0;
            let churnedMrr = 0;
            let trialStarts = 0;
            let paidConversions = 0;
            for (const subscription of subscriptionRows) {
                const start = Date.parse(String(subscription.started_at));
                const end = subscription.ended_at ? Date.parse(String(subscription.ended_at)) : Number.POSITIVE_INFINITY;
                if (start <= timestamp && end > timestamp && subscription.status !== 'expired') endingMrr += Number(subscription.monthly_recurring_revenue);
                if (subscription.ended_at === date && subscription.status === 'cancelled') churnedMrr += Number(subscription.monthly_recurring_revenue);
                if (subscription.started_at === date && subscription.plan_name === 'trial') trialStarts++;
                if (subscription.started_at === date && Number(subscription.monthly_recurring_revenue) > 0) paidConversions++;
            }
            const rawActiveUsers = eventDateUsers.get(date)?.size ?? 0;
            metricRows.push({
                metric_date: date,
                signups: signupCounts.get(date) ?? 0,
                activated_users: activationCounts.get(date) ?? 0,
                active_users: daysAgo % 17 === 0 ? rawActiveUsers + 3 : rawActiveUsers,
                trial_starts: trialStarts,
                paid_conversions: paidConversions,
                ending_mrr: endingMrr,
                churned_mrr: churnedMrr,
                support_tickets: ticketCounts.get(date) ?? 0,
                source_updated_at: isoTime(timestamp + DAY_MS + 6 * 60 * 60 * 1000),
            });
        }
        await insertJsonRows(
            db,
            'daily_business_metrics',
            'metric_date date, signups integer, activated_users integer, active_users integer, trial_starts integer, paid_conversions integer, ending_mrr numeric, churned_mrr numeric, support_tickets integer, source_updated_at timestamptz',
            metricRows
        );

        await db.query(
            `INSERT INTO datasource_table_catalog
                (datasource_id, schema_name, table_name, display_name, description, dataset_key, source_type, is_agent_visible)
             SELECT d.id, 'public', seed.table_name, seed.display_name, seed.description, $1, 'preset', TRUE
             FROM data_source d
             CROSS JOIN jsonb_to_recordset($2::jsonb) AS seed(table_name text, display_name text, description text)
             WHERE d.is_local = 1
             ON CONFLICT (datasource_id, schema_name, table_name) DO UPDATE SET
                display_name = EXCLUDED.display_name, description = EXCLUDED.description,
                dataset_key = EXCLUDED.dataset_key, source_type = EXCLUDED.source_type,
                is_agent_visible = EXCLUDED.is_agent_visible`,
            [DATASET_KEY, JSON.stringify(TABLE_CATALOG.map(([table_name, display_name, description]) => ({ table_name, display_name, description })))]
        );
        await db.query("UPDATE data_source SET description = '内置 B2B SaaS 产品、增长、收入与体验分析演示库' WHERE is_local = 1");
        await db.query('COMMIT');
    } catch (error) {
        await db.query('ROLLBACK');
        throw error;
    }
}
