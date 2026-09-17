# Phase 3 决策与实施记录：证据与上下文

> 阶段状态：已完成
>
> 完成日期：2026-09-17
>
> 实施边界：以 [Phase 3 实施合同](./11-phase-3-implementation-contract.md) 为准

## 1. 阶段结论

Phase 3 已建立“Turn → Query Artifact → Chart Artifact”的证据链。新查询在发送 table event 前持久化 Query Artifact；图表只提交 Artifact ID 和字段映射，数值由服务端从已保存结果构造；历史上下文按完整 Turn 裁剪，需要历史行数据时通过受权限保护的 read tool 读取。

这一阶段解决的是“结论使用了哪份证据”，不是“这份证据的业务口径一定正确”。后者需要 Phase 4 的 ResultQuality、fail-closed 和数据库最小权限。

## 2. 重构前为什么不够好

- 聊天消息同时承担“表达”和“查询证据”两种职责。Prompt 压缩会丢弃行数据，后续追问只能依赖模型记忆。
- user 和 assistant 以单条消息进入预算，可能产生孤立问题或孤立回答。
- `generate_chart` 接收模型复制的 `xAxis/series`，图表与表格是两份无法证明一致的数字副本。
- 固定 context window 和工具预留不匹配不同模型与实际 tool schema，既可能超窗，也可能过度裁剪。
- 可见数组长度、SQL LIMIT 和业务总量没有稳定区分，容易把样本误说成全集。

## 3. 根因与方案取舍

根因不是 Prompt 写得不够强，而是系统没有独立的证据身份、轮次身份和服务端引用关系。因此最终选择了三个可由代码验证的不变量：

1. 查询成功后先保存 Artifact，再向 UI 发 table；持久化失败不得静默降级成无证据表格。
2. Chart Artifact 仅保存 Query Artifact 引用和字段映射；图表数值不再由模型提交。
3. completed 历史以整 Turn 进入预算；failed/cancelled 默认排除，当前 pending Turn 只携带确切的 request。

没有选择“永久把完整查询结果放进 Prompt”，因为它会线性消耗 token 并扩大数据暴露面。也没有一次删除 `blocks/llm_messages`，因为现有 UI、snapshot 和旧历史仍需要兼容路径。

## 4. 实际交付

### 4.1 数据与运行契约

- 新增 QueryPlan、Query Artifact、Chart Artifact、Conversation Turn、Schema 目录/详情类型和 Artifact 稳定错误码。
- `promptPolicy/toolset/contextPolicy/schemaContext` 分别升级为 v3/v3/v3/v2。
- 新增 `conversation_turn`、`query_artifact`、`chart_artifact` 表、外键、唯一约束、索引和幂等历史 Turn 回填。

### 4.2 Query Artifact 双写

- SQL Executor 返回 PostgreSQL field metadata，将值保守规范化为 number/string/date/boolean/unknown。超过 JavaScript 安全整数或无法无损转换的 numeric 保留为 string/unknown。
- 结果行以稳定 JSON 计算 SHA-256；单 Artifact 上限 5 MiB。
- table block/event 保留兼容数据，同时增加 `queryArtifactId`、列类型、hash 和 limited 语义。
- `totalRowCount` 默认不推导；可见数组长度不冒充业务总量。

### 4.3 Chart Artifact 与历史证据

- `generate_chart` v3 只接收 `queryArtifactId/xField/yFields/filters/sort`，服务端验证字段与数值类型后生成现有前端 chart data。
- `read_query_artifact` 默认最多返回前 100 行。读取校验 user、conversation、当前 datasource 权限、过期时间和 Turn 状态。
- 历史 Artifact 只能来自 completed Turn；仅知道 ID、失败轮次或已撤权数据源都不能解锁图表。

### 4.4 Turn 与动态预算

- API 创建 generation 时在同一事务创建 pending Turn；Worker finalize 时同事务更新 Turn 状态、final answer 和完成时间。
- PromptBuilder 只读已完成历史和当前 request，并以整 Turn 做 full/结构化摘要/省略。Prompt 仅携带 Artifact 摘要与 ID，不重复注入 JSONB 行。
- model capability registry 根据模型窗口和回复预留分配历史预算，工具定义按实际 JSON schema 计费。
- 建立 SchemaCatalogSummary/SchemaDetail 接口；大规模召回与 Prompt 路径切换留给 Phase 6。

## 5. 重构后为什么更好

| 重构前             | 重构后                              | 收益成立的原因                                   |
| ------------------ | ----------------------------------- | ------------------------------------------------ |
| 表格只是聊天 block | block 指向有 hash 的 Query Artifact | 持久化失败时不发 table，因此新表格不会没有证据   |
| 模型复制图表数组   | 服务端从 Artifact 字段生成          | 图表和表格共用同一行集，不存在第二份数字真相     |
| 单消息裁剪         | 完整 Turn 降级                      | completed 问答成对加入或移除，不会留下半回合     |
| 历史数据靠模型记忆 | 受权 read tool                      | 每次重读都重新检查当前权限，撤权立即生效         |
| 固定工具预留       | 实际 schema 计费                    | 增减工具会直接改变可用历史预算，不再依赖手写估值 |

## 6. 兼容、开关与回滚

- `ARTIFACT_DUAL_WRITE_ENABLED=0`：停止新 Query Artifact 写入，保留旧 table block 路径。
- `ARTIFACT_CHART_READ_ENABLED=0`：关闭 Artifact read/chart 路径。
- `TURN_CONTEXT_READ_ENABLED=0`：PromptBuilder 回到基于 message 的历史读取。
- 新表只做前向兼容迁移；回滚代码时保留已写 Artifact，不执行破坏性 down migration。
- `blocks`、`llm_messages`、旧 SSE 数据仍可读取/回放。新 generation 不再生成 v2 `xAxis/series` 工具参数。

## 7. 自动化验证证据

| 入口                             | 主要证明                                                                                                 | 结果                  |
| -------------------------------- | -------------------------------------------------------------------------------------------------------- | --------------------- |
| `pnpm test:phase3-migrations`    | 建表、历史 completed/failed/cancelled 回填、稳定 sequence、重复执行                                      | PASS                  |
| `pnpm test:phase3-artifacts`     | 双写/hash、5 MiB、字段类型、Chart、100 行读取、跨用户/会话、撤权、过期、completed Turn、取消写栅栏、开关 | PASS                  |
| `pnpm test:phase3-context`       | completed-only、当前 request、整 Turn 降级、Artifact 摘要、工具 schema 计费、两种窗口、Schema 接口、回滚 | PASS                  |
| `pnpm test:reasoning`            | reasoning 历史协议兼容                                                                                   | PASS                  |
| `pnpm test:generation-baseline`  | generation 基线                                                                                          | PASS                  |
| `pnpm test:phase1-reliability`   | 串行、snapshot、writer fence、stale worker、Redis 暂停、超时/取消、SQL 取消                              | PASS                  |
| `pnpm test:phase2-orchestration` | 状态机和完整 mock Agent Loop                                                                             | PASS                  |
| `pnpm benchmark:analytics`       | 40 SQL cases + 6 semantic cases                                                                          | PASS                  |
| `pnpm typecheck` / `pnpm build`  | 全仓类型与构建                                                                                           | PASS                  |
| 隔离 mock API/Worker smoke       | 真实 Outbox/Redis/Worker 队列、2 路并发、非零游标重连、终态事件缺失时的 DB 快照恢复、失败 generation 重试、3 个 Turn finalize/final answer | PASS（3/3 completed） |

浏览器交互验收未自动运行；当前前端保持旧 block 渲染，Artifact ID/hash 作为兼容元数据保存。

## 8. 未解决问题与下一阶段

- Query Artifact 证明“执行了什么”，不证明 JOIN 基数、时区、空值和指标口径正确；Phase 4 增加 ResultQuality。
- 应用层 AST 校验仍不是数据库最终写保护；Phase 4 引入独立只读角色与 fail-closed。
- Schema 目录/详情接口已建立，但 Prompt 大规模按需召回、缓存和评测留给 Phase 6。
- Artifact 默认随 conversation 删除，尚未启用生产 TTL/清理任务；保留策略由 Phase 6 统一实施。
- 真实模型的端到端回答质量不由本阶段的确定性 mock 测试代替；Phase 6 建立发布级 Agent 评测。
