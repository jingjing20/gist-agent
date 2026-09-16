-- B2B SaaS 产品、增长、收入、实验、客服与数据质量分析基准
-- dataset=saas_growth_demo; anchor_date=2026-09-15; version=1

-- BASIC-001 | 基础统计 | 这个数据集包含多少客户账户和产品用户？
SELECT (SELECT COUNT(*) FROM customer_accounts) AS accounts, (SELECT COUNT(*) FROM product_users) AS users;

-- BASIC-002 | 基础统计 | 各客户分层分别有多少账户？
SELECT segment, COUNT(*) AS accounts FROM customer_accounts GROUP BY segment ORDER BY segment;

-- BASIC-003 | 基础统计 | 各获客渠道带来了多少注册用户？
SELECT acquisition_channel, COUNT(*) AS users FROM product_users GROUP BY acquisition_channel ORDER BY users DESC, acquisition_channel;

-- BASIC-004 | 基础统计 | 当前有效订阅数和总 MRR 是多少？
SELECT COUNT(*) AS active_subscriptions, SUM(monthly_recurring_revenue)::numeric(14,2) AS total_mrr FROM subscriptions WHERE status = 'active';

-- BASIC-005 | 基础统计 | 各账单状态的数量和应收总额分别是多少？
SELECT status, COUNT(*) AS invoices, SUM(gross_amount - discount_amount + tax_amount)::numeric(14,2) AS receivable FROM invoices GROUP BY status ORDER BY status;

-- FUNNEL-001 | 漏斗与激活 | 截至锚点日，注册用户中有多少完成激活，整体激活率是多少？
SELECT COUNT(*) AS signups, COUNT(*) FILTER (WHERE activated_at IS NOT NULL) AS activated, ROUND(100.0 * COUNT(*) FILTER (WHERE activated_at IS NOT NULL) / COUNT(*), 2) AS activation_pct FROM product_users WHERE signup_at < TIMESTAMPTZ '2026-09-16 00:00:00+00';

-- FUNNEL-002 | 漏斗与激活 | 整体 7 日激活率是多少？
SELECT COUNT(*) AS eligible_users, COUNT(*) FILTER (WHERE activated_at <= signup_at + INTERVAL '7 days') AS activated_7d, ROUND(100.0 * COUNT(*) FILTER (WHERE activated_at <= signup_at + INTERVAL '7 days') / COUNT(*), 2) AS activation_7d_pct FROM product_users WHERE signup_at < TIMESTAMPTZ '2026-09-08 00:00:00+00';

-- FUNNEL-003 | 漏斗与激活 | 不同获客渠道的 7 日激活率如何？
SELECT acquisition_channel, COUNT(*) AS eligible_users, COUNT(*) FILTER (WHERE activated_at <= signup_at + INTERVAL '7 days') AS activated_7d, ROUND(100.0 * COUNT(*) FILTER (WHERE activated_at <= signup_at + INTERVAL '7 days') / COUNT(*), 2) AS activation_7d_pct FROM product_users WHERE signup_at < TIMESTAMPTZ '2026-09-08 00:00:00+00' GROUP BY acquisition_channel ORDER BY activation_7d_pct DESC, acquisition_channel;

-- FUNNEL-004 | 漏斗与激活 | 不同客户分层的 7 日激活率如何？
SELECT a.segment, COUNT(*) AS eligible_users, COUNT(*) FILTER (WHERE u.activated_at <= u.signup_at + INTERVAL '7 days') AS activated_7d, ROUND(100.0 * COUNT(*) FILTER (WHERE u.activated_at <= u.signup_at + INTERVAL '7 days') / COUNT(*), 2) AS activation_7d_pct FROM product_users u JOIN customer_accounts a ON a.id = u.account_id WHERE u.signup_at < TIMESTAMPTZ '2026-09-08 00:00:00+00' GROUP BY a.segment ORDER BY a.segment;

-- FUNNEL-005 | 漏斗与激活 | 注册、创建工作区、连接数据、执行首次查询的用户漏斗是多少？
WITH dedup AS (SELECT DISTINCT user_id, event_name FROM product_events WHERE event_name IN ('signup','create_workspace','connect_data','run_query')) SELECT COUNT(*) FILTER (WHERE event_name='signup') AS signup_users, COUNT(*) FILTER (WHERE event_name='create_workspace') AS workspace_users, COUNT(*) FILTER (WHERE event_name='connect_data') AS connected_users, COUNT(*) FILTER (WHERE event_name='run_query') AS query_users FROM dedup;

-- RETENTION-001 | 留存与活跃 | 激活用户和未激活用户的注册后 30 日留存率分别是多少？
WITH eligible AS (SELECT id, signup_at, activated_at IS NOT NULL AS activated FROM product_users WHERE signup_at < TIMESTAMPTZ '2026-08-16 00:00:00+00'), retained AS (SELECT DISTINCT e.id FROM eligible e JOIN product_events p ON p.user_id=e.id AND p.event_time >= e.signup_at + INTERVAL '30 days' AND p.event_time < e.signup_at + INTERVAL '37 days') SELECT activated, COUNT(*) AS eligible_users, COUNT(r.id) AS retained_users, ROUND(100.0*COUNT(r.id)/COUNT(*),2) AS retention_pct FROM eligible e LEFT JOIN retained r ON r.id=e.id GROUP BY activated ORDER BY activated;

-- RETENTION-002 | 留存与活跃 | 过去 30 个完整 UTC 日的平均 DAU 是多少？
WITH daily AS (SELECT (event_time AT TIME ZONE 'UTC')::date AS dt, COUNT(DISTINCT user_id) AS dau FROM product_events WHERE event_time >= TIMESTAMPTZ '2026-08-16 00:00:00+00' AND event_time < TIMESTAMPTZ '2026-09-15 00:00:00+00' GROUP BY 1) SELECT ROUND(AVG(dau),2) AS avg_dau, MIN(dau) AS min_dau, MAX(dau) AS max_dau FROM daily;

-- RETENTION-003 | 留存与活跃 | 过去 30 个完整 UTC 日，各客户分层的月活跃用户数是多少？
SELECT a.segment, COUNT(DISTINCT e.user_id) AS mau FROM product_events e JOIN customer_accounts a ON a.id=e.account_id WHERE e.event_time >= TIMESTAMPTZ '2026-08-16 00:00:00+00' AND e.event_time < TIMESTAMPTZ '2026-09-15 00:00:00+00' GROUP BY a.segment ORDER BY a.segment;

-- REVENUE-001 | 收入与订阅 | 当前 MRR 按客户分层如何分布？
SELECT a.segment, COUNT(*) AS active_subscriptions, SUM(s.monthly_recurring_revenue)::numeric(14,2) AS mrr, ROUND(AVG(s.monthly_recurring_revenue),2) AS arpa FROM subscriptions s JOIN customer_accounts a ON a.id=s.account_id WHERE s.status='active' GROUP BY a.segment ORDER BY a.segment;

-- REVENUE-002 | 收入与订阅 | 取消订阅的主要原因是什么？
SELECT cancellation_reason, COUNT(*) AS cancelled_accounts, SUM(monthly_recurring_revenue)::numeric(14,2) AS churned_mrr FROM subscriptions WHERE status='cancelled' GROUP BY cancellation_reason ORDER BY cancelled_accounts DESC, cancellation_reason;

-- REVENUE-003 | 收入与订阅 | 账单整体回款率和逾期金额是多少？
SELECT SUM(gross_amount-discount_amount+tax_amount)::numeric(14,2) AS total_receivable, SUM(paid_amount-refunded_amount)::numeric(14,2) AS net_cash, ROUND(100.0*SUM(paid_amount-refunded_amount)/SUM(gross_amount-discount_amount+tax_amount),2) AS collection_pct, SUM(gross_amount-discount_amount+tax_amount) FILTER (WHERE status='overdue')::numeric(14,2) AS overdue_amount FROM invoices;

-- REVENUE-004 | 收入与订阅 | 各获客渠道当前贡献多少 MRR，付费账户转化率如何？
SELECT a.acquisition_channel, COUNT(*) AS accounts, COUNT(*) FILTER (WHERE s.status='active') AS active_paid_accounts, ROUND(100.0*COUNT(*) FILTER (WHERE s.status='active')/COUNT(*),2) AS active_paid_pct, COALESCE(SUM(s.monthly_recurring_revenue) FILTER (WHERE s.status='active'),0)::numeric(14,2) AS current_mrr FROM customer_accounts a LEFT JOIN subscriptions s ON s.account_id=a.id GROUP BY a.acquisition_channel ORDER BY current_mrr DESC, a.acquisition_channel;

-- REVENUE-005 | 收入与订阅 | 不同客户分层的逾期账单率是多少？
SELECT a.segment, COUNT(*) AS invoices, COUNT(*) FILTER (WHERE i.status='overdue') AS overdue_invoices, ROUND(100.0*COUNT(*) FILTER (WHERE i.status='overdue')/COUNT(*),2) AS overdue_pct FROM invoices i JOIN customer_accounts a ON a.id=i.account_id GROUP BY a.segment ORDER BY a.segment;

-- MARKETING-001 | 营销归因 | 各营销活动带来的账户数、用户数和当前 MRR 是多少？
WITH users AS (SELECT campaign_id, COUNT(*) AS users FROM product_users GROUP BY campaign_id), accounts AS (SELECT campaign_id, COUNT(*) AS accounts FROM customer_accounts GROUP BY campaign_id), revenue AS (SELECT a.campaign_id, SUM(s.monthly_recurring_revenue) FILTER (WHERE s.status='active') AS mrr FROM customer_accounts a LEFT JOIN subscriptions s ON s.account_id=a.id GROUP BY a.campaign_id) SELECT c.name, COALESCE(a.accounts,0) AS accounts, COALESCE(u.users,0) AS users, COALESCE(r.mrr,0)::numeric(14,2) AS current_mrr FROM marketing_campaigns c LEFT JOIN accounts a ON a.campaign_id=c.id LEFT JOIN users u ON u.campaign_id=c.id LEFT JOIN revenue r ON r.campaign_id=c.id ORDER BY current_mrr DESC, c.id;

-- MARKETING-002 | 营销归因 | 按当前 MRR 粗略计算，各营销活动的预算回收月数是多少？
WITH revenue AS (SELECT a.campaign_id, SUM(s.monthly_recurring_revenue) FILTER (WHERE s.status='active') AS mrr FROM customer_accounts a LEFT JOIN subscriptions s ON s.account_id=a.id GROUP BY a.campaign_id) SELECT c.name, c.budget::numeric(14,2) AS budget, COALESCE(r.mrr,0)::numeric(14,2) AS current_mrr, CASE WHEN COALESCE(r.mrr,0)>0 THEN ROUND(c.budget/r.mrr,2) END AS payback_months FROM marketing_campaigns c LEFT JOIN revenue r ON r.campaign_id=c.id ORDER BY payback_months NULLS LAST, c.id;

-- EXPERIMENT-001 | 实验分析 | onboarding_flow_v2 实验各版本的分配、曝光和曝光率是多少？
SELECT variant, COUNT(*) AS assigned, COUNT(*) FILTER (WHERE exposure_at IS NOT NULL) AS exposed, ROUND(100.0*COUNT(*) FILTER (WHERE exposure_at IS NOT NULL)/COUNT(*),2) AS exposure_pct FROM experiment_assignments WHERE experiment_key='onboarding_flow_v2' GROUP BY variant ORDER BY variant;

-- EXPERIMENT-002 | 实验分析 | 仅看实际曝光用户，实验各版本的 7 日激活率是多少？
SELECT a.variant, COUNT(*) AS exposed_users, COUNT(*) FILTER (WHERE u.activated_at <= u.signup_at + INTERVAL '7 days') AS activated_7d, ROUND(100.0*COUNT(*) FILTER (WHERE u.activated_at <= u.signup_at + INTERVAL '7 days')/COUNT(*),2) AS activation_7d_pct FROM experiment_assignments a JOIN product_users u ON u.id=a.user_id WHERE a.experiment_key='onboarding_flow_v2' AND a.exposure_at IS NOT NULL GROUP BY a.variant ORDER BY a.variant;

-- EXPERIMENT-003 | 实验分析 | 实验分组在设备类型上是否大致均衡？
SELECT a.variant, u.device_type, COUNT(*) AS users, ROUND(100.0*COUNT(*)/SUM(COUNT(*)) OVER (PARTITION BY a.variant),2) AS share_pct FROM experiment_assignments a JOIN product_users u ON u.id=a.user_id WHERE a.exposure_at IS NOT NULL GROUP BY a.variant,u.device_type ORDER BY a.variant,u.device_type;

-- RELEASE-001 | 版本与异常 | 3.4.0 发布事故前、事故窗口和修复后的导出失败率分别是多少？
WITH exports AS (SELECT CASE WHEN event_time >= TIMESTAMPTZ '2026-07-26 00:00:00+00' AND event_time < TIMESTAMPTZ '2026-08-01 00:00:00+00' THEN 'before' WHEN event_time >= TIMESTAMPTZ '2026-08-01 00:00:00+00' AND event_time < TIMESTAMPTZ '2026-08-07 00:00:00+00' THEN 'incident' WHEN event_time >= TIMESTAMPTZ '2026-08-07 00:00:00+00' AND event_time < TIMESTAMPTZ '2026-08-13 00:00:00+00' THEN 'after' END AS period,event_name FROM product_events WHERE event_name IN ('export_success','export_failed') AND event_time >= TIMESTAMPTZ '2026-07-26 00:00:00+00' AND event_time < TIMESTAMPTZ '2026-08-13 00:00:00+00') SELECT period,COUNT(*) AS exports,COUNT(*) FILTER (WHERE event_name='export_failed') AS failures,ROUND(100.0*COUNT(*) FILTER (WHERE event_name='export_failed')/COUNT(*),2) AS failure_pct FROM exports GROUP BY period ORDER BY CASE period WHEN 'before' THEN 1 WHEN 'incident' THEN 2 ELSE 3 END;

-- RELEASE-002 | 版本与异常 | 3.4.0 事故窗口与之前六天相比，客服工单量和平均 CSAT 如何变化？
SELECT CASE WHEN opened_at >= TIMESTAMPTZ '2026-07-26 00:00:00+00' AND opened_at < TIMESTAMPTZ '2026-08-01 00:00:00+00' THEN 'before' ELSE 'incident' END AS period, COUNT(*) AS tickets, ROUND(AVG(csat_score),2) AS avg_csat FROM support_tickets WHERE opened_at >= TIMESTAMPTZ '2026-07-26 00:00:00+00' AND opened_at < TIMESTAMPTZ '2026-08-07 00:00:00+00' GROUP BY period ORDER BY period DESC;

-- RELEASE-003 | 版本与异常 | AI Search 上线后有多少用户使用过搜索，占同期活跃用户多少？
SELECT COUNT(DISTINCT user_id) FILTER (WHERE event_name='search') AS search_users, COUNT(DISTINCT user_id) AS active_users, ROUND(100.0*COUNT(DISTINCT user_id) FILTER (WHERE event_name='search')/COUNT(DISTINCT user_id),2) AS adoption_pct FROM product_events WHERE event_time >= TIMESTAMPTZ '2026-08-01 00:00:00+00' AND event_time < TIMESTAMPTZ '2026-09-16 00:00:00+00';

-- RELEASE-004 | 版本与异常 | 自动化功能发布后有多少用户和账户使用过 automation_run？
SELECT COUNT(DISTINCT user_id) AS users, COUNT(DISTINCT account_id) AS accounts, COUNT(*) AS events FROM product_events WHERE event_name='automation_run' AND event_time >= TIMESTAMPTZ '2026-08-28 00:00:00+00';

-- SUPPORT-001 | 客服体验 | 不同优先级工单的平均首次响应时间和平均解决时间是多少？
SELECT priority,COUNT(*) AS tickets,ROUND(AVG(EXTRACT(EPOCH FROM first_response_at-opened_at)/3600),2) AS avg_response_hours,ROUND(AVG(EXTRACT(EPOCH FROM resolved_at-opened_at)/3600),2) AS avg_resolution_hours FROM support_tickets GROUP BY priority ORDER BY priority;

-- SUPPORT-002 | 客服体验 | 3.4.0 相关工单和其他工单的满意度分别是多少？
SELECT CASE WHEN related_version='3.4.0' THEN '3.4.0 incident' ELSE 'other' END AS ticket_group,COUNT(*) AS tickets,COUNT(csat_score) AS rated_tickets,ROUND(AVG(csat_score),2) AS avg_csat FROM support_tickets GROUP BY 1 ORDER BY 1;

-- SUPPORT-003 | 客服体验 | 有过客服工单和没有客服工单的账户，取消订阅率分别是多少？
WITH ticket_accounts AS (SELECT DISTINCT account_id FROM support_tickets) SELECT (t.account_id IS NOT NULL) AS had_ticket,COUNT(*) AS accounts,COUNT(*) FILTER (WHERE s.status='cancelled') AS cancelled,ROUND(100.0*COUNT(*) FILTER (WHERE s.status='cancelled')/COUNT(*),2) AS cancellation_pct FROM customer_accounts a JOIN subscriptions s ON s.account_id=a.id LEFT JOIN ticket_accounts t ON t.account_id=a.id GROUP BY 1 ORDER BY 1;

-- QUALITY-001 | 数据质量 | 客户账户的 region 字段有多少缺失？缺失率是多少？
SELECT COUNT(*) AS accounts,COUNT(*) FILTER (WHERE region IS NULL) AS missing_region,ROUND(100.0*COUNT(*) FILTER (WHERE region IS NULL)/COUNT(*),2) AS missing_pct FROM customer_accounts;

-- QUALITY-002 | 数据质量 | 产品事件中有多少逻辑重复记录？
SELECT COUNT(*) AS rows,COUNT(DISTINCT (user_id,session_id,event_name,event_time)) AS distinct_business_events,COUNT(*)-COUNT(DISTINCT (user_id,session_id,event_name,event_time)) AS logical_duplicates FROM product_events;

-- QUALITY-003 | 数据质量 | 有多少事件延迟至少两天入仓，占比是多少？
SELECT COUNT(*) AS events,COUNT(*) FILTER (WHERE ingested_at-event_time >= INTERVAL '2 days') AS late_events,ROUND(100.0*COUNT(*) FILTER (WHERE ingested_at-event_time >= INTERVAL '2 days')/COUNT(*),2) AS late_pct FROM product_events;

-- QUALITY-004 | 数据质量 | 每日经营汇总中的 DAU 有多少天与事件明细不一致？
WITH raw AS (SELECT (event_time AT TIME ZONE 'UTC')::date AS metric_date,COUNT(DISTINCT user_id) AS dau FROM product_events GROUP BY 1) SELECT COUNT(*) AS compared_days,COUNT(*) FILTER (WHERE d.active_users<>COALESCE(r.dau,0)) AS mismatch_days,MAX(ABS(d.active_users-COALESCE(r.dau,0))) AS max_abs_difference FROM daily_business_metrics d LEFT JOIN raw r USING(metric_date);

-- QUALITY-005 | 数据质量 | APAC Android 用户在埋点缺口前、中、后的日均活跃人数是多少？
WITH dates AS (SELECT d::date AS dt,CASE WHEN d::date BETWEEN DATE '2026-08-12' AND DATE '2026-08-14' THEN 'outage' WHEN d::date BETWEEN DATE '2026-08-09' AND DATE '2026-08-11' THEN 'before' ELSE 'after' END AS period FROM generate_series(DATE '2026-08-09',DATE '2026-08-17',INTERVAL '1 day') d),daily AS (SELECT (e.event_time AT TIME ZONE 'UTC')::date AS dt,COUNT(DISTINCT e.user_id) AS dau FROM product_events e JOIN customer_accounts a ON a.id=e.account_id WHERE a.region='apac' AND e.device_type='android' GROUP BY 1) SELECT dates.period,ROUND(AVG(COALESCE(daily.dau,0)),2) AS avg_dau,MIN(COALESCE(daily.dau,0)) AS min_dau,MAX(COALESCE(daily.dau,0)) AS max_dau FROM dates LEFT JOIN daily USING(dt) GROUP BY dates.period ORDER BY CASE dates.period WHEN 'before' THEN 1 WHEN 'outage' THEN 2 ELSE 3 END;

-- QUALITY-006 | 数据质量 | 删除逻辑重复事件后，事件总量会减少多少，各事件类型受影响多少？
WITH ranked AS (SELECT event_name,ROW_NUMBER() OVER(PARTITION BY user_id,session_id,event_name,event_time ORDER BY id) AS rn FROM product_events) SELECT event_name,COUNT(*) FILTER (WHERE rn>1) AS duplicates_removed FROM ranked GROUP BY event_name HAVING COUNT(*) FILTER (WHERE rn>1)>0 ORDER BY duplicates_removed DESC,event_name;

-- QUALITY-007 | 数据质量 | 核心事实表是否存在无法关联到维表的孤儿记录？
SELECT (SELECT COUNT(*) FROM product_events e LEFT JOIN product_users u ON u.id=e.user_id WHERE u.id IS NULL) AS orphan_event_users,(SELECT COUNT(*) FROM product_events e LEFT JOIN customer_accounts a ON a.id=e.account_id WHERE a.id IS NULL) AS orphan_event_accounts,(SELECT COUNT(*) FROM subscriptions s LEFT JOIN customer_accounts a ON a.id=s.account_id WHERE a.id IS NULL) AS orphan_subscriptions,(SELECT COUNT(*) FROM invoices i LEFT JOIN subscriptions s ON s.id=i.subscription_id WHERE s.id IS NULL) AS orphan_invoices;

-- ADVANCED-001 | 综合分析 | 过去 30 个完整日活跃用户最多的 10 个账户，其当前 MRR 是多少？
WITH usage AS (SELECT account_id,COUNT(DISTINCT user_id) AS active_users,COUNT(*) AS events FROM product_events WHERE event_time >= TIMESTAMPTZ '2026-08-16 00:00:00+00' AND event_time < TIMESTAMPTZ '2026-09-15 00:00:00+00' GROUP BY account_id),revenue AS (SELECT account_id,SUM(monthly_recurring_revenue) FILTER(WHERE status='active') AS mrr FROM subscriptions GROUP BY account_id) SELECT a.id,a.account_name,a.segment,u.active_users,u.events,COALESCE(r.mrr,0)::numeric(14,2) AS current_mrr FROM usage u JOIN customer_accounts a ON a.id=u.account_id LEFT JOIN revenue r ON r.account_id=a.id ORDER BY u.active_users DESC,u.events DESC,a.id LIMIT 10;

-- ADVANCED-002 | 综合分析 | AI Search 在不同付费套餐中的采用率是多少？
WITH eligible AS (SELECT DISTINCT u.id AS user_id,s.plan_name FROM product_users u JOIN subscriptions s ON s.account_id=u.account_id WHERE s.status='active'),adopters AS (SELECT DISTINCT user_id FROM product_events WHERE event_name='search' AND event_time >= TIMESTAMPTZ '2026-08-01 00:00:00+00') SELECT e.plan_name,COUNT(*) AS eligible_users,COUNT(a.user_id) AS adopters,ROUND(100.0*COUNT(a.user_id)/COUNT(*),2) AS adoption_pct FROM eligible e LEFT JOIN adopters a USING(user_id) GROUP BY e.plan_name ORDER BY e.plan_name;

-- ADVANCED-003 | 综合分析 | 按渠道比较注册规模、7 日激活率、当前付费账户率和当前 MRR。
WITH user_metrics AS (SELECT acquisition_channel,COUNT(*) AS users,COUNT(*) FILTER(WHERE activated_at<=signup_at+INTERVAL '7 days') AS activated_7d FROM product_users WHERE signup_at<TIMESTAMPTZ '2026-09-08 00:00:00+00' GROUP BY acquisition_channel),account_metrics AS (SELECT a.acquisition_channel,COUNT(*) AS accounts,COUNT(*) FILTER(WHERE s.status='active') AS paid_accounts,COALESCE(SUM(s.monthly_recurring_revenue) FILTER(WHERE s.status='active'),0) AS mrr FROM customer_accounts a LEFT JOIN subscriptions s ON s.account_id=a.id GROUP BY a.acquisition_channel) SELECT u.acquisition_channel,u.users,ROUND(100.0*u.activated_7d/u.users,2) AS activation_7d_pct,a.accounts,ROUND(100.0*a.paid_accounts/a.accounts,2) AS paid_account_pct,a.mrr::numeric(14,2) AS current_mrr FROM user_metrics u JOIN account_metrics a USING(acquisition_channel) ORDER BY current_mrr DESC,u.acquisition_channel;

