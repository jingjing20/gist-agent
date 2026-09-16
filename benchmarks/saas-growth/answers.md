# SaaS Growth Demo 常见问题与标准答案

- 数据集：`saas_growth_demo`
- 固定数据日期：`2026-09-15`
- 用例版本：`1`

> 标准答案用于核对口径和关键结果，不要求 Agent 使用完全相同的措辞或 SQL。金额单位均为人民币元，事件日期默认按 UTC 解释。

## BASIC-001 · 这个数据集包含多少客户账户和产品用户？

- 分类：基础统计
- 难度：easy
- 涉及表：`customer_accounts`、`product_users`

标准结果：

| accounts | users |
| --- | --- |
| 300 | 1570 |

<details>
<summary>参考 SQL</summary>

```sql
SELECT (SELECT COUNT(*) FROM customer_accounts) AS accounts, (SELECT COUNT(*) FROM product_users) AS users
```

</details>

评分提示：

- 分别说明账户粒度和用户粒度，不应把两者混为客户数

## BASIC-002 · 各客户分层分别有多少账户？

- 分类：基础统计
- 难度：easy
- 涉及表：`customer_accounts`

标准结果：

| segment | accounts |
| --- | --- |
| enterprise | 20 |
| mid_market | 70 |
| smb | 210 |

<details>
<summary>参考 SQL</summary>

```sql
SELECT segment, COUNT(*) AS accounts FROM customer_accounts GROUP BY segment ORDER BY segment
```

</details>

评分提示：

- 按账户去重

## BASIC-003 · 各获客渠道带来了多少注册用户？

- 分类：基础统计
- 难度：easy
- 涉及表：`product_users`

标准结果：

| acquisition_channel | users |
| --- | --- |
| organic | 235 |
| outbound | 232 |
| paid_social | 222 |
| content | 215 |
| paid_search | 169 |
| partner | 167 |
| event | 166 |
| referral | 164 |

<details>
<summary>参考 SQL</summary>

```sql
SELECT acquisition_channel, COUNT(*) AS users FROM product_users GROUP BY acquisition_channel ORDER BY users DESC, acquisition_channel
```

</details>

评分提示：

- 这里统计用户注册量，不是账户量

## BASIC-004 · 当前有效订阅数和总 MRR 是多少？

- 分类：基础统计
- 难度：easy
- 涉及表：`subscriptions`

标准结果：

| active_subscriptions | total_mrr |
| --- | --- |
| 164 | 628365.00 |

<details>
<summary>参考 SQL</summary>

```sql
SELECT COUNT(*) AS active_subscriptions, SUM(monthly_recurring_revenue)::numeric(14,2) AS total_mrr FROM subscriptions WHERE status = 'active'
```

</details>

评分提示：

- 只包含 status=active 的订阅
- 金额单位为人民币元

## BASIC-005 · 各账单状态的数量和应收总额分别是多少？

- 分类：基础统计
- 难度：easy
- 涉及表：`invoices`

标准结果：

| status | invoices | receivable |
| --- | --- | --- |
| overdue | 76 | 372598.48 |
| paid | 1083 | 4541429.02 |
| refunded | 31 | 53133.56 |

<details>
<summary>参考 SQL</summary>

```sql
SELECT status, COUNT(*) AS invoices, SUM(gross_amount - discount_amount + tax_amount)::numeric(14,2) AS receivable FROM invoices GROUP BY status ORDER BY status
```

</details>

评分提示：

- 应收额口径为原价减折扣加税

## FUNNEL-001 · 截至锚点日，注册用户中有多少完成激活，整体激活率是多少？

- 分类：漏斗与激活
- 难度：medium
- 涉及表：`product_users`

标准结果：

| signups | activated | activation_pct |
| --- | --- | --- |
| 1570 | 1010 | 64.33 |

<details>
<summary>参考 SQL</summary>

```sql
SELECT COUNT(*) AS signups, COUNT(*) FILTER (WHERE activated_at IS NOT NULL) AS activated, ROUND(100.0 * COUNT(*) FILTER (WHERE activated_at IS NOT NULL) / COUNT(*), 2) AS activation_pct FROM product_users WHERE signup_at < TIMESTAMPTZ '2026-09-16 00:00:00+00'
```

</details>

评分提示：

- 这是最终激活率，不是 7 日激活率

## FUNNEL-002 · 整体 7 日激活率是多少？

- 分类：漏斗与激活
- 难度：medium
- 涉及表：`product_users`

标准结果：

| eligible_users | activated_7d | activation_7d_pct |
| --- | --- | --- |
| 1570 | 774 | 49.30 |

<details>
<summary>参考 SQL</summary>

```sql
SELECT COUNT(*) AS eligible_users, COUNT(*) FILTER (WHERE activated_at <= signup_at + INTERVAL '7 days') AS activated_7d, ROUND(100.0 * COUNT(*) FILTER (WHERE activated_at <= signup_at + INTERVAL '7 days') / COUNT(*), 2) AS activation_7d_pct FROM product_users WHERE signup_at < TIMESTAMPTZ '2026-09-08 00:00:00+00'
```

</details>

评分提示：

- 排除注册未满 7 天的用户，避免 cohort maturity 偏差

## FUNNEL-003 · 不同获客渠道的 7 日激活率如何？

- 分类：漏斗与激活
- 难度：medium
- 涉及表：`product_users`

标准结果：

| acquisition_channel | eligible_users | activated_7d | activation_7d_pct |
| --- | --- | --- | --- |
| referral | 164 | 96 | 58.54 |
| paid_search | 169 | 93 | 55.03 |
| organic | 235 | 126 | 53.62 |
| outbound | 232 | 120 | 51.72 |
| event | 166 | 78 | 46.99 |
| partner | 167 | 76 | 45.51 |
| content | 215 | 95 | 44.19 |
| paid_social | 222 | 90 | 40.54 |

<details>
<summary>参考 SQL</summary>

```sql
SELECT acquisition_channel, COUNT(*) AS eligible_users, COUNT(*) FILTER (WHERE activated_at <= signup_at + INTERVAL '7 days') AS activated_7d, ROUND(100.0 * COUNT(*) FILTER (WHERE activated_at <= signup_at + INTERVAL '7 days') / COUNT(*), 2) AS activation_7d_pct FROM product_users WHERE signup_at < TIMESTAMPTZ '2026-09-08 00:00:00+00' GROUP BY acquisition_channel ORDER BY activation_7d_pct DESC, acquisition_channel
```

</details>

评分提示：

- 应指出渠道的量和质可能不同

## FUNNEL-004 · 不同客户分层的 7 日激活率如何？

- 分类：漏斗与激活
- 难度：medium
- 涉及表：`product_users`、`customer_accounts`

标准结果：

| segment | eligible_users | activated_7d | activation_7d_pct |
| --- | --- | --- | --- |
| enterprise | 240 | 132 | 55.00 |
| mid_market | 490 | 233 | 47.55 |
| smb | 840 | 409 | 48.69 |

<details>
<summary>参考 SQL</summary>

```sql
SELECT a.segment, COUNT(*) AS eligible_users, COUNT(*) FILTER (WHERE u.activated_at <= u.signup_at + INTERVAL '7 days') AS activated_7d, ROUND(100.0 * COUNT(*) FILTER (WHERE u.activated_at <= u.signup_at + INTERVAL '7 days') / COUNT(*), 2) AS activation_7d_pct FROM product_users u JOIN customer_accounts a ON a.id = u.account_id WHERE u.signup_at < TIMESTAMPTZ '2026-09-08 00:00:00+00' GROUP BY a.segment ORDER BY a.segment
```

</details>

评分提示：

- 用户为分母，账户分层是分析维度

## FUNNEL-005 · 注册、创建工作区、连接数据、执行首次查询的用户漏斗是多少？

- 分类：漏斗与激活
- 难度：hard
- 涉及表：`product_events`

标准结果：

| signup_users | workspace_users | connected_users | query_users |
| --- | --- | --- | --- |
| 1570 | 1010 | 1010 | 1509 |

<details>
<summary>参考 SQL</summary>

```sql
WITH dedup AS (SELECT DISTINCT user_id, event_name FROM product_events WHERE event_name IN ('signup','create_workspace','connect_data','run_query')) SELECT COUNT(*) FILTER (WHERE event_name='signup') AS signup_users, COUNT(*) FILTER (WHERE event_name='create_workspace') AS workspace_users, COUNT(*) FILTER (WHERE event_name='connect_data') AS connected_users, COUNT(*) FILTER (WHERE event_name='run_query') AS query_users FROM dedup
```

</details>

评分提示：

- 必须按用户去重
- run_query 也包含后续日常行为，因此不能直接解释为严格顺序漏斗

## RETENTION-001 · 激活用户和未激活用户的注册后 30 日留存率分别是多少？

- 分类：留存与活跃
- 难度：hard
- 涉及表：`product_users`、`product_events`

标准结果：

| activated | eligible_users | retained_users | retention_pct |
| --- | --- | --- | --- |
| false | 554 | 42 | 7.58 |
| true | 994 | 241 | 24.25 |

<details>
<summary>参考 SQL</summary>

```sql
WITH eligible AS (SELECT id, signup_at, activated_at IS NOT NULL AS activated FROM product_users WHERE signup_at < TIMESTAMPTZ '2026-08-16 00:00:00+00'), retained AS (SELECT DISTINCT e.id FROM eligible e JOIN product_events p ON p.user_id=e.id AND p.event_time >= e.signup_at + INTERVAL '30 days' AND p.event_time < e.signup_at + INTERVAL '37 days') SELECT activated, COUNT(*) AS eligible_users, COUNT(r.id) AS retained_users, ROUND(100.0*COUNT(r.id)/COUNT(*),2) AS retention_pct FROM eligible e LEFT JOIN retained r ON r.id=e.id GROUP BY activated ORDER BY activated
```

</details>

评分提示：

- 定义为注册后第 30-36 天窗口留存
- 排除观察窗口未成熟用户

## RETENTION-002 · 过去 30 个完整 UTC 日的平均 DAU 是多少？

- 分类：留存与活跃
- 难度：medium
- 涉及表：`product_events`

标准结果：

| avg_dau | min_dau | max_dau |
| --- | --- | --- |
| 172.47 | 110 | 224 |

<details>
<summary>参考 SQL</summary>

```sql
WITH daily AS (SELECT (event_time AT TIME ZONE 'UTC')::date AS dt, COUNT(DISTINCT user_id) AS dau FROM product_events WHERE event_time >= TIMESTAMPTZ '2026-08-16 00:00:00+00' AND event_time < TIMESTAMPTZ '2026-09-15 00:00:00+00' GROUP BY 1) SELECT ROUND(AVG(dau),2) AS avg_dau, MIN(dau) AS min_dau, MAX(dau) AS max_dau FROM daily
```

</details>

评分提示：

- 不包含锚点当天
- 按 UTC 日期聚合

## RETENTION-003 · 过去 30 个完整 UTC 日，各客户分层的月活跃用户数是多少？

- 分类：留存与活跃
- 难度：medium
- 涉及表：`product_events`、`customer_accounts`

标准结果：

| segment | mau |
| --- | --- |
| enterprise | 206 |
| mid_market | 405 |
| smb | 651 |

<details>
<summary>参考 SQL</summary>

```sql
SELECT a.segment, COUNT(DISTINCT e.user_id) AS mau FROM product_events e JOIN customer_accounts a ON a.id=e.account_id WHERE e.event_time >= TIMESTAMPTZ '2026-08-16 00:00:00+00' AND e.event_time < TIMESTAMPTZ '2026-09-15 00:00:00+00' GROUP BY a.segment ORDER BY a.segment
```

</details>

评分提示：

- MAU 按用户去重，不是事件数

## REVENUE-001 · 当前 MRR 按客户分层如何分布？

- 分类：收入与订阅
- 难度：medium
- 涉及表：`subscriptions`、`customer_accounts`

标准结果：

| segment | active_subscriptions | mrr | arpa |
| --- | --- | --- | --- |
| enterprise | 12 | 283846.00 | 23653.83 |
| mid_market | 37 | 232334.00 | 6279.30 |
| smb | 115 | 112185.00 | 975.52 |

<details>
<summary>参考 SQL</summary>

```sql
SELECT a.segment, COUNT(*) AS active_subscriptions, SUM(s.monthly_recurring_revenue)::numeric(14,2) AS mrr, ROUND(AVG(s.monthly_recurring_revenue),2) AS arpa FROM subscriptions s JOIN customer_accounts a ON a.id=s.account_id WHERE s.status='active' GROUP BY a.segment ORDER BY a.segment
```

</details>

评分提示：

- ARPA 在当前模型中按有效订阅账户计算

## REVENUE-002 · 取消订阅的主要原因是什么？

- 分类：收入与订阅
- 难度：medium
- 涉及表：`subscriptions`

标准结果：

| cancellation_reason | cancelled_accounts | churned_mrr |
| --- | --- | --- |
| company_closed | 7 | 34817.00 |
| missing_features | 6 | 12276.00 |
| low_usage | 4 | 3971.00 |
| poor_support | 2 | 1800.00 |
| price | 1 | 1073.00 |

<details>
<summary>参考 SQL</summary>

```sql
SELECT cancellation_reason, COUNT(*) AS cancelled_accounts, SUM(monthly_recurring_revenue)::numeric(14,2) AS churned_mrr FROM subscriptions WHERE status='cancelled' GROUP BY cancellation_reason ORDER BY cancelled_accounts DESC, cancellation_reason
```

</details>

评分提示：

- 同时比较账户数与流失 MRR，避免只看频次

## REVENUE-003 · 账单整体回款率和逾期金额是多少？

- 分类：收入与订阅
- 难度：medium
- 涉及表：`invoices`

标准结果：

| total_receivable | net_cash | collection_pct | overdue_amount |
| --- | --- | --- | --- |
| 4967161.06 | 4541429.02 | 91.43 | 372598.48 |

<details>
<summary>参考 SQL</summary>

```sql
SELECT SUM(gross_amount-discount_amount+tax_amount)::numeric(14,2) AS total_receivable, SUM(paid_amount-refunded_amount)::numeric(14,2) AS net_cash, ROUND(100.0*SUM(paid_amount-refunded_amount)/SUM(gross_amount-discount_amount+tax_amount),2) AS collection_pct, SUM(gross_amount-discount_amount+tax_amount) FILTER (WHERE status='overdue')::numeric(14,2) AS overdue_amount FROM invoices
```

</details>

评分提示：

- 净回款需要扣除退款

## REVENUE-004 · 各获客渠道当前贡献多少 MRR，付费账户转化率如何？

- 分类：收入与订阅
- 难度：hard
- 涉及表：`customer_accounts`、`subscriptions`

标准结果：

| acquisition_channel | accounts | active_paid_accounts | active_paid_pct | current_mrr |
| --- | --- | --- | --- | --- |
| outbound | 40 | 24 | 60.00 | 157710.00 |
| organic | 44 | 30 | 68.18 | 99873.00 |
| paid_search | 29 | 15 | 51.72 | 84167.00 |
| referral | 36 | 28 | 77.78 | 63012.00 |
| partner | 32 | 17 | 53.13 | 62214.00 |
| event | 32 | 17 | 53.13 | 61778.00 |
| paid_social | 44 | 13 | 29.55 | 58490.00 |
| content | 43 | 20 | 46.51 | 41121.00 |

<details>
<summary>参考 SQL</summary>

```sql
SELECT a.acquisition_channel, COUNT(*) AS accounts, COUNT(*) FILTER (WHERE s.status='active') AS active_paid_accounts, ROUND(100.0*COUNT(*) FILTER (WHERE s.status='active')/COUNT(*),2) AS active_paid_pct, COALESCE(SUM(s.monthly_recurring_revenue) FILTER (WHERE s.status='active'),0)::numeric(14,2) AS current_mrr FROM customer_accounts a LEFT JOIN subscriptions s ON s.account_id=a.id GROUP BY a.acquisition_channel ORDER BY current_mrr DESC, a.acquisition_channel
```

</details>

评分提示：

- 渠道归因采用账户表末次触达渠道
- 这是收入贡献而非严格增量 ROI

## REVENUE-005 · 不同客户分层的逾期账单率是多少？

- 分类：收入与订阅
- 难度：medium
- 涉及表：`invoices`、`customer_accounts`

标准结果：

| segment | invoices | overdue_invoices | overdue_pct |
| --- | --- | --- | --- |
| enterprise | 95 | 7 | 7.37 |
| mid_market | 273 | 23 | 8.42 |
| smb | 822 | 46 | 5.60 |

<details>
<summary>参考 SQL</summary>

```sql
SELECT a.segment, COUNT(*) AS invoices, COUNT(*) FILTER (WHERE i.status='overdue') AS overdue_invoices, ROUND(100.0*COUNT(*) FILTER (WHERE i.status='overdue')/COUNT(*),2) AS overdue_pct FROM invoices i JOIN customer_accounts a ON a.id=i.account_id GROUP BY a.segment ORDER BY a.segment
```

</details>

评分提示：

- 按账单张数计算，不是按金额

## MARKETING-001 · 各营销活动带来的账户数、用户数和当前 MRR 是多少？

- 分类：营销归因
- 难度：medium
- 涉及表：`marketing_campaigns`、`customer_accounts`、`product_users`、`subscriptions`

标准结果：

| name | accounts | users | current_mrr |
| --- | --- | --- | --- |
| 企业 ABM 计划 | 40 | 232 | 157710.00 |
| 品牌词常青计划 | 29 | 169 | 84167.00 |
| 客户推荐计划 | 36 | 164 | 63012.00 |
| 合作伙伴加速器 | 32 | 167 | 62214.00 |
| 春季效率峰会 | 32 | 166 | 61778.00 |
| 亚太增长实验 | 44 | 222 | 58490.00 |
| 内容增长引擎 | 43 | 215 | 41121.00 |
| 夏日扩张 | 0 | 0 | 0.00 |

<details>
<summary>参考 SQL</summary>

```sql
WITH users AS (SELECT campaign_id, COUNT(*) AS users FROM product_users GROUP BY campaign_id), accounts AS (SELECT campaign_id, COUNT(*) AS accounts FROM customer_accounts GROUP BY campaign_id), revenue AS (SELECT a.campaign_id, SUM(s.monthly_recurring_revenue) FILTER (WHERE s.status='active') AS mrr FROM customer_accounts a LEFT JOIN subscriptions s ON s.account_id=a.id GROUP BY a.campaign_id) SELECT c.name, COALESCE(a.accounts,0) AS accounts, COALESCE(u.users,0) AS users, COALESCE(r.mrr,0)::numeric(14,2) AS current_mrr FROM marketing_campaigns c LEFT JOIN accounts a ON a.campaign_id=c.id LEFT JOIN users u ON u.campaign_id=c.id LEFT JOIN revenue r ON r.campaign_id=c.id ORDER BY current_mrr DESC, c.id
```

</details>

评分提示：

- 先分别聚合再 JOIN，避免账户、用户、订阅之间发生扇出重复

## MARKETING-002 · 按当前 MRR 粗略计算，各营销活动的预算回收月数是多少？

- 分类：营销归因
- 难度：hard
- 涉及表：`marketing_campaigns`、`customer_accounts`、`subscriptions`

标准结果：

| name | budget | current_mrr | payback_months |
| --- | --- | --- | --- |
| 客户推荐计划 | 70000.00 | 63012.00 | 1.11 |
| 品牌词常青计划 | 180000.00 | 84167.00 | 2.14 |
| 内容增长引擎 | 90000.00 | 41121.00 | 2.19 |
| 企业 ABM 计划 | 500000.00 | 157710.00 | 3.17 |
| 亚太增长实验 | 210000.00 | 58490.00 | 3.59 |
| 合作伙伴加速器 | 260000.00 | 62214.00 | 4.18 |
| 春季效率峰会 | 320000.00 | 61778.00 | 5.18 |
| 夏日扩张 | 420000.00 | 0.00 | NULL |

<details>
<summary>参考 SQL</summary>

```sql
WITH revenue AS (SELECT a.campaign_id, SUM(s.monthly_recurring_revenue) FILTER (WHERE s.status='active') AS mrr FROM customer_accounts a LEFT JOIN subscriptions s ON s.account_id=a.id GROUP BY a.campaign_id) SELECT c.name, c.budget::numeric(14,2) AS budget, COALESCE(r.mrr,0)::numeric(14,2) AS current_mrr, CASE WHEN COALESCE(r.mrr,0)>0 THEN ROUND(c.budget/r.mrr,2) END AS payback_months FROM marketing_campaigns c LEFT JOIN revenue r ON r.campaign_id=c.id ORDER BY payback_months NULLS LAST, c.id
```

</details>

评分提示：

- 这是静态粗估，不等同于严格 CAC payback
- 没有毛利和增量归因信息

## EXPERIMENT-001 · onboarding_flow_v2 实验各版本的分配、曝光和曝光率是多少？

- 分类：实验分析
- 难度：medium
- 涉及表：`experiment_assignments`

标准结果：

| variant | assigned | exposed | exposure_pct |
| --- | --- | --- | --- |
| control | 106 | 96 | 90.57 |
| guided | 112 | 103 | 91.96 |

<details>
<summary>参考 SQL</summary>

```sql
SELECT variant, COUNT(*) AS assigned, COUNT(*) FILTER (WHERE exposure_at IS NOT NULL) AS exposed, ROUND(100.0*COUNT(*) FILTER (WHERE exposure_at IS NOT NULL)/COUNT(*),2) AS exposure_pct FROM experiment_assignments WHERE experiment_key='onboarding_flow_v2' GROUP BY variant ORDER BY variant
```

</details>

评分提示：

- 区分分配样本和实际曝光样本

## EXPERIMENT-002 · 仅看实际曝光用户，实验各版本的 7 日激活率是多少？

- 分类：实验分析
- 难度：hard
- 涉及表：`experiment_assignments`、`product_users`

标准结果：

| variant | exposed_users | activated_7d | activation_7d_pct |
| --- | --- | --- | --- |
| control | 96 | 40 | 41.67 |
| guided | 103 | 57 | 55.34 |

<details>
<summary>参考 SQL</summary>

```sql
SELECT a.variant, COUNT(*) AS exposed_users, COUNT(*) FILTER (WHERE u.activated_at <= u.signup_at + INTERVAL '7 days') AS activated_7d, ROUND(100.0*COUNT(*) FILTER (WHERE u.activated_at <= u.signup_at + INTERVAL '7 days')/COUNT(*),2) AS activation_7d_pct FROM experiment_assignments a JOIN product_users u ON u.id=a.user_id WHERE a.experiment_key='onboarding_flow_v2' AND a.exposure_at IS NOT NULL GROUP BY a.variant ORDER BY a.variant
```

</details>

评分提示：

- 结论范围仅限已曝光用户
- 百分比差异不自动等于统计显著

## EXPERIMENT-003 · 实验分组在设备类型上是否大致均衡？

- 分类：实验分析
- 难度：hard
- 涉及表：`experiment_assignments`、`product_users`

标准结果：

| variant | device_type | users | share_pct |
| --- | --- | --- | --- |
| control | android | 15 | 15.63 |
| control | ios | 19 | 19.79 |
| control | web | 62 | 64.58 |
| guided | android | 18 | 17.48 |
| guided | ios | 24 | 23.30 |
| guided | web | 61 | 59.22 |

<details>
<summary>参考 SQL</summary>

```sql
SELECT a.variant, u.device_type, COUNT(*) AS users, ROUND(100.0*COUNT(*)/SUM(COUNT(*)) OVER (PARTITION BY a.variant),2) AS share_pct FROM experiment_assignments a JOIN product_users u ON u.id=a.user_id WHERE a.exposure_at IS NOT NULL GROUP BY a.variant,u.device_type ORDER BY a.variant,u.device_type
```

</details>

评分提示：

- 比较每个版本内部设备构成
- 小幅随机差异不代表分流失败

## RELEASE-001 · 3.4.0 发布事故前、事故窗口和修复后的导出失败率分别是多少？

- 分类：版本与异常
- 难度：hard
- 涉及表：`product_events`、`product_releases`

标准结果：

| period | exports | failures | failure_pct |
| --- | --- | --- | --- |
| before | 192 | 0 | 0.00 |
| incident | 237 | 92 | 38.82 |
| after | 247 | 0 | 0.00 |

<details>
<summary>参考 SQL</summary>

```sql
WITH exports AS (SELECT CASE WHEN event_time >= TIMESTAMPTZ '2026-07-26 00:00:00+00' AND event_time < TIMESTAMPTZ '2026-08-01 00:00:00+00' THEN 'before' WHEN event_time >= TIMESTAMPTZ '2026-08-01 00:00:00+00' AND event_time < TIMESTAMPTZ '2026-08-07 00:00:00+00' THEN 'incident' WHEN event_time >= TIMESTAMPTZ '2026-08-07 00:00:00+00' AND event_time < TIMESTAMPTZ '2026-08-13 00:00:00+00' THEN 'after' END AS period,event_name FROM product_events WHERE event_name IN ('export_success','export_failed') AND event_time >= TIMESTAMPTZ '2026-07-26 00:00:00+00' AND event_time < TIMESTAMPTZ '2026-08-13 00:00:00+00') SELECT period,COUNT(*) AS exports,COUNT(*) FILTER (WHERE event_name='export_failed') AS failures,ROUND(100.0*COUNT(*) FILTER (WHERE event_name='export_failed')/COUNT(*),2) AS failure_pct FROM exports GROUP BY period ORDER BY CASE period WHEN 'before' THEN 1 WHEN 'incident' THEN 2 ELSE 3 END
```

</details>

评分提示：

- 窗口使用 UTC
- 时间共现支持关联判断，但仍不单独证明唯一因果

## RELEASE-002 · 3.4.0 事故窗口与之前六天相比，客服工单量和平均 CSAT 如何变化？

- 分类：版本与异常
- 难度：medium
- 涉及表：`support_tickets`

标准结果：

| period | tickets | avg_csat |
| --- | --- | --- |
| incident | 88 | 1.96 |
| before | 22 | 3.94 |

<details>
<summary>参考 SQL</summary>

```sql
SELECT CASE WHEN opened_at >= TIMESTAMPTZ '2026-07-26 00:00:00+00' AND opened_at < TIMESTAMPTZ '2026-08-01 00:00:00+00' THEN 'before' ELSE 'incident' END AS period, COUNT(*) AS tickets, ROUND(AVG(csat_score),2) AS avg_csat FROM support_tickets WHERE opened_at >= TIMESTAMPTZ '2026-07-26 00:00:00+00' AND opened_at < TIMESTAMPTZ '2026-08-07 00:00:00+00' GROUP BY period ORDER BY period DESC
```

</details>

评分提示：

- CSAT 的分母仅包括有评分工单

## RELEASE-003 · AI Search 上线后有多少用户使用过搜索，占同期活跃用户多少？

- 分类：版本与异常
- 难度：medium
- 涉及表：`product_events`、`product_releases`

标准结果：

| search_users | active_users | adoption_pct |
| --- | --- | --- |
| 1191 | 1360 | 87.57 |

<details>
<summary>参考 SQL</summary>

```sql
SELECT COUNT(DISTINCT user_id) FILTER (WHERE event_name='search') AS search_users, COUNT(DISTINCT user_id) AS active_users, ROUND(100.0*COUNT(DISTINCT user_id) FILTER (WHERE event_name='search')/COUNT(DISTINCT user_id),2) AS adoption_pct FROM product_events WHERE event_time >= TIMESTAMPTZ '2026-08-01 00:00:00+00' AND event_time < TIMESTAMPTZ '2026-09-16 00:00:00+00'
```

</details>

评分提示：

- 同期活跃用户是分母，不是全部注册用户

## RELEASE-004 · 自动化功能发布后有多少用户和账户使用过 automation_run？

- 分类：版本与异常
- 难度：medium
- 涉及表：`product_events`

标准结果：

| users | accounts | events |
| --- | --- | --- |
| 422 | 210 | 517 |

<details>
<summary>参考 SQL</summary>

```sql
SELECT COUNT(DISTINCT user_id) AS users, COUNT(DISTINCT account_id) AS accounts, COUNT(*) AS events FROM product_events WHERE event_name='automation_run' AND event_time >= TIMESTAMPTZ '2026-08-28 00:00:00+00'
```

</details>

评分提示：

- 区分采用用户、采用账户和使用次数

## SUPPORT-001 · 不同优先级工单的平均首次响应时间和平均解决时间是多少？

- 分类：客服体验
- 难度：medium
- 涉及表：`support_tickets`

标准结果：

| priority | tickets | avg_response_hours | avg_resolution_hours |
| --- | --- | --- | --- |
| high | 163 | 2.98 | 23.59 |
| low | 98 | 12.14 | 33.54 |
| medium | 219 | 12.86 | 32.92 |

<details>
<summary>参考 SQL</summary>

```sql
SELECT priority,COUNT(*) AS tickets,ROUND(AVG(EXTRACT(EPOCH FROM first_response_at-opened_at)/3600),2) AS avg_response_hours,ROUND(AVG(EXTRACT(EPOCH FROM resolved_at-opened_at)/3600),2) AS avg_resolution_hours FROM support_tickets GROUP BY priority ORDER BY priority
```

</details>

评分提示：

- 平均解决时间自动排除 resolved_at 为 NULL 的未解决工单

## SUPPORT-002 · 3.4.0 相关工单和其他工单的满意度分别是多少？

- 分类：客服体验
- 难度：medium
- 涉及表：`support_tickets`

标准结果：

| ticket_group | tickets | rated_tickets | avg_csat |
| --- | --- | --- | --- |
| 3.4.0 incident | 88 | 80 | 1.96 |
| other | 392 | 356 | 3.97 |

<details>
<summary>参考 SQL</summary>

```sql
SELECT CASE WHEN related_version='3.4.0' THEN '3.4.0 incident' ELSE 'other' END AS ticket_group,COUNT(*) AS tickets,COUNT(csat_score) AS rated_tickets,ROUND(AVG(csat_score),2) AS avg_csat FROM support_tickets GROUP BY 1 ORDER BY 1
```

</details>

评分提示：

- 同时报告评分样本量

## SUPPORT-003 · 有过客服工单和没有客服工单的账户，取消订阅率分别是多少？

- 分类：客服体验
- 难度：hard
- 涉及表：`support_tickets`、`customer_accounts`、`subscriptions`

标准结果：

| had_ticket | accounts | cancelled | cancellation_pct |
| --- | --- | --- | --- |
| false | 64 | 4 | 6.25 |
| true | 236 | 16 | 6.78 |

<details>
<summary>参考 SQL</summary>

```sql
WITH ticket_accounts AS (SELECT DISTINCT account_id FROM support_tickets) SELECT (t.account_id IS NOT NULL) AS had_ticket,COUNT(*) AS accounts,COUNT(*) FILTER (WHERE s.status='cancelled') AS cancelled,ROUND(100.0*COUNT(*) FILTER (WHERE s.status='cancelled')/COUNT(*),2) AS cancellation_pct FROM customer_accounts a JOIN subscriptions s ON s.account_id=a.id LEFT JOIN ticket_accounts t ON t.account_id=a.id GROUP BY 1 ORDER BY 1
```

</details>

评分提示：

- 这是观察相关性，不能据此断言工单导致流失

## QUALITY-001 · 客户账户的 region 字段有多少缺失？缺失率是多少？

- 分类：数据质量
- 难度：easy
- 涉及表：`customer_accounts`

标准结果：

| accounts | missing_region | missing_pct |
| --- | --- | --- |
| 300 | 4 | 1.33 |

<details>
<summary>参考 SQL</summary>

```sql
SELECT COUNT(*) AS accounts,COUNT(*) FILTER (WHERE region IS NULL) AS missing_region,ROUND(100.0*COUNT(*) FILTER (WHERE region IS NULL)/COUNT(*),2) AS missing_pct FROM customer_accounts
```

</details>

评分提示：

- NULL 与零或未知类别不可混用

## QUALITY-002 · 产品事件中有多少逻辑重复记录？

- 分类：数据质量
- 难度：medium
- 涉及表：`product_events`

标准结果：

| rows | distinct_business_events | logical_duplicates |
| --- | --- | --- |
| 56778 | 56461 | 317 |

<details>
<summary>参考 SQL</summary>

```sql
SELECT COUNT(*) AS rows,COUNT(DISTINCT (user_id,session_id,event_name,event_time)) AS distinct_business_events,COUNT(*)-COUNT(DISTINCT (user_id,session_id,event_name,event_time)) AS logical_duplicates FROM product_events
```

</details>

评分提示：

- event_uuid 唯一不代表没有业务语义重复

## QUALITY-003 · 有多少事件延迟至少两天入仓，占比是多少？

- 分类：数据质量
- 难度：medium
- 涉及表：`product_events`

标准结果：

| events | late_events | late_pct |
| --- | --- | --- |
| 56778 | 1433 | 2.52 |

<details>
<summary>参考 SQL</summary>

```sql
SELECT COUNT(*) AS events,COUNT(*) FILTER (WHERE ingested_at-event_time >= INTERVAL '2 days') AS late_events,ROUND(100.0*COUNT(*) FILTER (WHERE ingested_at-event_time >= INTERVAL '2 days')/COUNT(*),2) AS late_pct FROM product_events
```

</details>

评分提示：

- 比较 event_time 与 ingested_at

## QUALITY-004 · 每日经营汇总中的 DAU 有多少天与事件明细不一致？

- 分类：数据质量
- 难度：hard
- 涉及表：`daily_business_metrics`、`product_events`

标准结果：

| compared_days | mismatch_days | max_abs_difference |
| --- | --- | --- |
| 120 | 8 | 3 |

<details>
<summary>参考 SQL</summary>

```sql
WITH raw AS (SELECT (event_time AT TIME ZONE 'UTC')::date AS metric_date,COUNT(DISTINCT user_id) AS dau FROM product_events GROUP BY 1) SELECT COUNT(*) AS compared_days,COUNT(*) FILTER (WHERE d.active_users<>COALESCE(r.dau,0)) AS mismatch_days,MAX(ABS(d.active_users-COALESCE(r.dau,0))) AS max_abs_difference FROM daily_business_metrics d LEFT JOIN raw r USING(metric_date)
```

</details>

评分提示：

- 必须按 UTC 日期对齐
- 不能用事件行数代替去重用户数

## QUALITY-005 · APAC Android 用户在埋点缺口前、中、后的日均活跃人数是多少？

- 分类：数据质量
- 难度：hard
- 涉及表：`product_events`、`customer_accounts`

标准结果：

| period | avg_dau | min_dau | max_dau |
| --- | --- | --- | --- |
| before | 6.33 | 4 | 8 |
| outage | 0.00 | 0 | 0 |
| after | 5.67 | 5 | 7 |

<details>
<summary>参考 SQL</summary>

```sql
WITH dates AS (SELECT d::date AS dt,CASE WHEN d::date BETWEEN DATE '2026-08-12' AND DATE '2026-08-14' THEN 'outage' WHEN d::date BETWEEN DATE '2026-08-09' AND DATE '2026-08-11' THEN 'before' ELSE 'after' END AS period FROM generate_series(DATE '2026-08-09',DATE '2026-08-17',INTERVAL '1 day') d),daily AS (SELECT (e.event_time AT TIME ZONE 'UTC')::date AS dt,COUNT(DISTINCT e.user_id) AS dau FROM product_events e JOIN customer_accounts a ON a.id=e.account_id WHERE a.region='apac' AND e.device_type='android' GROUP BY 1) SELECT dates.period,ROUND(AVG(COALESCE(daily.dau,0)),2) AS avg_dau,MIN(COALESCE(daily.dau,0)) AS min_dau,MAX(COALESCE(daily.dau,0)) AS max_dau FROM dates LEFT JOIN daily USING(dt) GROUP BY dates.period ORDER BY CASE dates.period WHEN 'before' THEN 1 WHEN 'outage' THEN 2 ELSE 3 END
```

</details>

评分提示：

- 必须补全日期后再计算，否则缺失日会被排除而非按零观察

## QUALITY-006 · 删除逻辑重复事件后，事件总量会减少多少，各事件类型受影响多少？

- 分类：数据质量
- 难度：hard
- 涉及表：`product_events`

标准结果：

| event_name | duplicates_removed |
| --- | --- |
| login | 101 |
| run_query | 92 |
| create_dashboard | 37 |
| export_success | 26 |
| search | 23 |
| signup | 10 |
| invite_member | 9 |
| automation_run | 7 |
| connect_data | 7 |
| create_workspace | 5 |

<details>
<summary>参考 SQL</summary>

```sql
WITH ranked AS (SELECT event_name,ROW_NUMBER() OVER(PARTITION BY user_id,session_id,event_name,event_time ORDER BY id) AS rn FROM product_events) SELECT event_name,COUNT(*) FILTER (WHERE rn>1) AS duplicates_removed FROM ranked GROUP BY event_name HAVING COUNT(*) FILTER (WHERE rn>1)>0 ORDER BY duplicates_removed DESC,event_name
```

</details>

评分提示：

- 去重业务键必须明确且稳定

## QUALITY-007 · 核心事实表是否存在无法关联到维表的孤儿记录？

- 分类：数据质量
- 难度：medium
- 涉及表：`product_events`、`product_users`、`customer_accounts`、`subscriptions`、`invoices`

标准结果：

| orphan_event_users | orphan_event_accounts | orphan_subscriptions | orphan_invoices |
| --- | --- | --- | --- |
| 0 | 0 | 0 | 0 |

<details>
<summary>参考 SQL</summary>

```sql
SELECT (SELECT COUNT(*) FROM product_events e LEFT JOIN product_users u ON u.id=e.user_id WHERE u.id IS NULL) AS orphan_event_users,(SELECT COUNT(*) FROM product_events e LEFT JOIN customer_accounts a ON a.id=e.account_id WHERE a.id IS NULL) AS orphan_event_accounts,(SELECT COUNT(*) FROM subscriptions s LEFT JOIN customer_accounts a ON a.id=s.account_id WHERE a.id IS NULL) AS orphan_subscriptions,(SELECT COUNT(*) FROM invoices i LEFT JOIN subscriptions s ON s.id=i.subscription_id WHERE s.id IS NULL) AS orphan_invoices
```

</details>

评分提示：

- 外键存在仍应在质量检查中验证实际结果

## ADVANCED-001 · 过去 30 个完整日活跃用户最多的 10 个账户，其当前 MRR 是多少？

- 分类：综合分析
- 难度：hard
- 涉及表：`product_events`、`customer_accounts`、`subscriptions`

标准结果：

| id | account_name | segment | active_users | events | current_mrr |
| --- | --- | --- | --- | --- | --- |
| 300 | 示例客户-300 | enterprise | 12 | 275 | 24747.00 |
| 150 | 示例客户-150 | enterprise | 12 | 246 | 0.00 |
| 45 | 示例客户-045 | enterprise | 12 | 243 | 0.00 |
| 90 | 示例客户-090 | enterprise | 12 | 201 | 20091.00 |
| 195 | 示例客户-195 | enterprise | 12 | 173 | 21508.00 |
| 270 | 示例客户-270 | enterprise | 11 | 266 | 20973.00 |
| 240 | 示例客户-240 | enterprise | 11 | 238 | 28787.00 |
| 180 | 示例客户-180 | enterprise | 11 | 232 | 29375.00 |
| 120 | 示例客户-120 | enterprise | 11 | 208 | 19562.00 |
| 165 | 示例客户-165 | enterprise | 11 | 192 | 0.00 |

<details>
<summary>参考 SQL</summary>

```sql
WITH usage AS (SELECT account_id,COUNT(DISTINCT user_id) AS active_users,COUNT(*) AS events FROM product_events WHERE event_time >= TIMESTAMPTZ '2026-08-16 00:00:00+00' AND event_time < TIMESTAMPTZ '2026-09-15 00:00:00+00' GROUP BY account_id),revenue AS (SELECT account_id,SUM(monthly_recurring_revenue) FILTER(WHERE status='active') AS mrr FROM subscriptions GROUP BY account_id) SELECT a.id,a.account_name,a.segment,u.active_users,u.events,COALESCE(r.mrr,0)::numeric(14,2) AS current_mrr FROM usage u JOIN customer_accounts a ON a.id=u.account_id LEFT JOIN revenue r ON r.account_id=a.id ORDER BY u.active_users DESC,u.events DESC,a.id LIMIT 10
```

</details>

评分提示：

- 先按账户聚合使用和收入，避免事实表直接 JOIN 产生扇出

## ADVANCED-002 · AI Search 在不同付费套餐中的采用率是多少？

- 分类：综合分析
- 难度：hard
- 涉及表：`product_events`、`product_users`、`subscriptions`

标准结果：

| plan_name | eligible_users | adopters | adoption_pct |
| --- | --- | --- | --- |
| enterprise | 144 | 128 | 88.89 |
| starter | 460 | 367 | 79.78 |
| team | 259 | 208 | 80.31 |

<details>
<summary>参考 SQL</summary>

```sql
WITH eligible AS (SELECT DISTINCT u.id AS user_id,s.plan_name FROM product_users u JOIN subscriptions s ON s.account_id=u.account_id WHERE s.status='active'),adopters AS (SELECT DISTINCT user_id FROM product_events WHERE event_name='search' AND event_time >= TIMESTAMPTZ '2026-08-01 00:00:00+00') SELECT e.plan_name,COUNT(*) AS eligible_users,COUNT(a.user_id) AS adopters,ROUND(100.0*COUNT(a.user_id)/COUNT(*),2) AS adoption_pct FROM eligible e LEFT JOIN adopters a USING(user_id) GROUP BY e.plan_name ORDER BY e.plan_name
```

</details>

评分提示：

- 分母为当前有效付费订阅下的用户

## ADVANCED-003 · 按渠道比较注册规模、7 日激活率、当前付费账户率和当前 MRR。

- 分类：综合分析
- 难度：hard
- 涉及表：`product_users`、`customer_accounts`、`subscriptions`

标准结果：

| acquisition_channel | users | activation_7d_pct | accounts | paid_account_pct | current_mrr |
| --- | --- | --- | --- | --- | --- |
| outbound | 232 | 51.72 | 40 | 60.00 | 157710.00 |
| organic | 235 | 53.62 | 44 | 68.18 | 99873.00 |
| paid_search | 169 | 55.03 | 29 | 51.72 | 84167.00 |
| referral | 164 | 58.54 | 36 | 77.78 | 63012.00 |
| partner | 167 | 45.51 | 32 | 53.13 | 62214.00 |
| event | 166 | 46.99 | 32 | 53.13 | 61778.00 |
| paid_social | 222 | 40.54 | 44 | 29.55 | 58490.00 |
| content | 215 | 44.19 | 43 | 46.51 | 41121.00 |

<details>
<summary>参考 SQL</summary>

```sql
WITH user_metrics AS (SELECT acquisition_channel,COUNT(*) AS users,COUNT(*) FILTER(WHERE activated_at<=signup_at+INTERVAL '7 days') AS activated_7d FROM product_users WHERE signup_at<TIMESTAMPTZ '2026-09-08 00:00:00+00' GROUP BY acquisition_channel),account_metrics AS (SELECT a.acquisition_channel,COUNT(*) AS accounts,COUNT(*) FILTER(WHERE s.status='active') AS paid_accounts,COALESCE(SUM(s.monthly_recurring_revenue) FILTER(WHERE s.status='active'),0) AS mrr FROM customer_accounts a LEFT JOIN subscriptions s ON s.account_id=a.id GROUP BY a.acquisition_channel) SELECT u.acquisition_channel,u.users,ROUND(100.0*u.activated_7d/u.users,2) AS activation_7d_pct,a.accounts,ROUND(100.0*a.paid_accounts/a.accounts,2) AS paid_account_pct,a.mrr::numeric(14,2) AS current_mrr FROM user_metrics u JOIN account_metrics a USING(acquisition_channel) ORDER BY current_mrr DESC,u.acquisition_channel
```

</details>

评分提示：

- 用户激活和账户付费使用不同分母
- 不可直接平均两个比率

## REASON-001 · 客服工单是否导致了客户取消订阅？

- 分类：因果边界
- 难度：hard
- 涉及表：`support_tickets`、`subscriptions`、`customer_accounts`

标准答案要点：

- 只能观察相关性
- 不能证明因果
- 选择偏差或反向因果
- 需要实验或更强识别策略

不可接受的结论：

- 客服工单导致取消订阅

评分提示：

- 有问题的客户更可能提交工单，也更可能流失，存在反向因果与混杂

## REASON-002 · guided 版本激活率更高，是否应该立即全量发布？

- 分类：因果边界
- 难度：hard
- 涉及表：`experiment_assignments`、`product_users`、`product_events`、`support_tickets`

标准答案要点：

- 曝光口径
- 统计不确定性
- 护栏指标
- 分流平衡

不可接受的结论：

- 仅凭点估计即可确定全量发布

评分提示：

- 应检查样本量、显著性、设备构成及负向护栏后再决策

## REASON-003 · 为什么直接 COUNT(*) product_events 不能作为 DAU？

- 分类：指标口径
- 难度：medium
- 涉及表：`product_events`

标准答案要点：

- 按日
- 去重用户
- 逻辑重复事件
- 时区

不可接受的结论：

- 事件数等于活跃用户数

评分提示：

- DAU 应按 UTC 自然日 COUNT DISTINCT user_id，并考虑重复事件

## REASON-004 · APAC Android 活跃下降是否说明该区域用户流失？

- 分类：数据质量
- 难度：hard
- 涉及表：`product_events`、`customer_accounts`、`product_users`

标准答案要点：

- 局部埋点缺失
- 平台和区域切片
- 不能直接解释为用户流失
- 使用其他数据源交叉验证

不可接受的结论：

- 活跃下降必然是用户流失

评分提示：

- 应先排查 2026-08-12 至 2026-08-14 的采集完整性

## REASON-005 · 当前 MRR 最高的营销活动是否一定最值得追加预算？

- 分类：营销归因
- 难度：hard
- 涉及表：`marketing_campaigns`、`customer_accounts`、`subscriptions`、`invoices`

标准答案要点：

- 归因不等于增量
- 预算或成本
- 回收周期
- 留存或毛利

不可接受的结论：

- 当前 MRR 最高就一定应该追加预算

评分提示：

- 还需控制投放时间、客户质量、自然转化和增量效果

## REASON-006 · 这个数据集能否回答竞争对手降价对我们流失率的影响？

- 分类：分析边界
- 难度：medium
- 涉及表：无可用内部表

标准答案要点：

- 无法回答
- 缺少竞争对手价格和时间数据
- 需要外部数据

不可接受的结论：

- 可以从现有数据确定竞争对手降价影响

评分提示：

- 正确拒答是评测能力的一部分

