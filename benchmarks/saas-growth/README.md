# SaaS Growth Demo 分析基准

这套基准用于人工核对 Agent 的分析结果，也可作为后续自动评测功能的数据源。数据为合成数据，不代表真实公司或用户。

## 固定条件

- 数据集键：`saas_growth_demo`
- 数据锚点：`2026-09-15T00:00:00Z`
- 默认时区：UTC
- 金额单位：人民币元
- 生成器使用固定伪随机种子，同一版本初始化结果稳定

任何会改变表结构、种子规律、行数或锚点日期的提交，都必须重新审核并刷新标准答案。不能仅因为验证失败就无条件执行更新命令。

## 数据模型

| 表 | 粒度 | 主要用途 |
| --- | --- | --- |
| `marketing_campaigns` | 每个营销活动一行 | 渠道投入、归因、粗略回收周期 |
| `product_releases` | 每个版本一行 | 发布前后分析、事故关联 |
| `customer_accounts` | 每个企业账户一行 | 行业、分层、区域和获客渠道 |
| `product_users` | 每个产品用户一行 | 注册、画像、激活和用户状态 |
| `subscriptions` | 每段账户订阅一行 | 套餐、席位、MRR 和取消原因 |
| `invoices` | 每张账单一行 | 应收、实收、逾期与退款 |
| `experiment_assignments` | 每个实验用户一行 | 分配、曝光、版本对比 |
| `product_events` | 每个采集事件一行 | 漏斗、活跃、留存、功能采用 |
| `support_tickets` | 每个工单一行 | SLA、CSAT、版本问题和流失关联 |
| `daily_business_metrics` | 每个 UTC 自然日一行 | 管理口径 KPI 与明细对账 |

核心关系：

```text
marketing_campaigns ──< customer_accounts ──< product_users
                              │                    │
                              ├──< subscriptions   ├──< experiment_assignments
                              │        │           └──< product_events
                              │        └──< invoices
                              └──< support_tickets

product_releases ──(version/time)── product_events / support_tickets
daily_business_metrics ──(UTC date)── product_events / subscriptions / support_tickets
```

## 规范指标口径

| 指标 | 定义 |
| --- | --- |
| 注册用户 | `product_users` 中符合时间范围的用户数 |
| 最终激活 | `activated_at IS NOT NULL` |
| 7 日激活 | `activated_at <= signup_at + interval '7 days'`；分母排除观察期未满 7 天的用户 |
| DAU | UTC 自然日内至少产生一个事件的去重 `user_id` |
| 30 日窗口留存 | 注册后第 30–36 天至少产生一个事件；分母排除观察窗口不成熟用户 |
| 当前 MRR | `subscriptions.status = 'active'` 的 `monthly_recurring_revenue` 合计 |
| 应收金额 | `gross_amount - discount_amount + tax_amount` |
| 净回款 | `paid_amount - refunded_amount` |
| 实验曝光样本 | `experiment_assignments.exposure_at IS NOT NULL` |
| 工单首次响应时长 | `first_response_at - opened_at` |
| 工单解决时长 | `resolved_at - opened_at`；未解决工单不进入平均值 |

## 内置分析线索

以下线索是基准设计的一部分，但评测 Agent 时不应直接放进用户问题：

- `paid_social` 注册规模与激活质量存在差异。
- `guided` onboarding 版本的 7 日激活点估计高于 `control`。
- `3.4.0` 发布窗口出现导出失败和客服工单峰值，`3.4.1` 后恢复。
- AI Search 和 Automation 在各自版本发布后产生采用数据。
- 企业、中型和小型客户的使用、收入及流失结构不同。
- 事件表包含少量逻辑重复与延迟入仓记录。
- APAC Android 在 `2026-08-12` 至 `2026-08-14` 存在局部采集缺口。
- `daily_business_metrics.active_users` 有 8 天与事件明细相差 3，用于口径对账。
- 少量账户缺失 `region`。

## 评测资产

- [`cases.json`](./cases.json)：机器可读问题、标准 SQL、标准结果和评分提示。
- [`answers.md`](./answers.md)：适合人工查阅的常见问题与标准答案，由更新命令生成。
- [`reference.sql`](./reference.sql)：全部标准 SQL，由更新命令生成。

评测时应以 `cases.json` 为事实来源。`answers.md` 和 `reference.sql` 是便于阅读的派生产物。

## 使用命令

初始化固定数据：

```bash
pnpm init-db
```

验证当前数据库仍符合已审核标准答案：

```bash
pnpm --filter @gist/api benchmark:analytics
```

只有在数据集变更已经人工审核后，才更新标准答案：

```bash
pnpm --filter @gist/api benchmark:analytics:update
```

更新命令会同时刷新 `cases.json` 中的 `expected`、`answers.md` 和 `reference.sql`。

## 自动评测建议

SQL 类题目应至少分别评估：

1. 是否只执行只读查询。
2. 是否选择正确的表和关联键。
3. 分析粒度、分母、时区和成熟窗口是否正确。
4. 最终值是否与 `expected.rows` 一致；允许展示层面的合理舍入。
5. 是否说明会改变结论的限制。

语义类题目使用 `must_include_concepts` 和 `must_not_claim` 做评分信号，不建议直接要求字符串完全一致。特别需要惩罚把相关性表述为因果、忽略实验曝光、混淆账户与用户粒度，以及把缺失数据解释为真实业务下降。
