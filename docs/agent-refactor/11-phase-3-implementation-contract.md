# Phase 3 实施合同：证据与上下文

> 合同状态：待实施；本文通过评审后作为 Phase 3 编码、测试和验收依据
>
> 目标周期：Phase 2 ORC-04 完成后开始
>
> 对应专题：[上下文与查询 Artifact](./03-context-and-artifacts.md)

## 1. 合同目标

Phase 3 必须交付一条可追溯证据链：一次成功查询生成唯一 Query Artifact，表格、回答上下文和 Chart Artifact 引用该证据；历史上下文按完整 Turn 裁剪，不再依赖模型从脱水消息中重建数据。

完成后必须能回答：某个图表数字来自哪个 generation、哪条最终 SQL、哪个 Query Artifact 和哪个字段。

## 2. 进入条件（Gate 0）

以下条件全部满足后才允许开始 Artifact 数据库迁移：

- ORC-04 完成：空 LLM 响应以稳定错误码失败，不得 completed。
- mock LLM 集成测试覆盖直接回答、单次/多次查询、查询失败重试、图表、迭代耗尽、取消和非法工具调用。
- Phase 1、Phase 2 现有回归继续通过。
- QueryPlan、Query Artifact、Chart Artifact 和 Turn 的 TypeScript/数据库字段评审通过。

Gate 0 不通过时可以编写设计和测试夹具，但不得合并数据库迁移或切换生产读取链路。

## 3. 范围与非目标

### 3.1 本阶段范围

- 最小 QueryPlan 契约。
- Query Artifact/Chart Artifact/Conversation Turn 数据模型。
- 查询成功后的 Artifact 双写。
- Chart 只引用 Artifact 字段，不接受模型提交数值数组。
- 按完整 Turn 构建上下文。
- Artifact 授权读取和后续追问。
- model capability registry、实际工具 schema 计费和整 Turn 降级。
- Schema 目录/详情接口契约，不包含大规模召回调优。

### 3.2 明确非目标

- 不实现数据库独立只读账号、完整 fail-closed 或 ResultQuality；由 Phase 4 承接。
- 不实现长期 MemoryRecord；由 Phase 5 承接。
- 不实现 Schema 检索排序、百表召回调优或生产成本 dashboard；由 Phase 6 承接。
- 不删除 `message.blocks`、`message.llm_messages` 或旧 SSE 兼容字段。
- 不从历史表格 block 反推或伪造 Query Artifact。

## 4. 冻结领域契约

### 4.1 QueryPlan v1

`execute_sql_query` 的运行时参数升级为：

```ts
interface QueryPlanV1 {
    purpose: string;
    expectedGrain: string;
    expectedShape: 'scalar' | 'timeseries' | 'category' | 'detail';
}

interface ExecuteSqlQueryArgsV2 {
    title: string;
    sql: string;
    plan: QueryPlanV1;
}
```

`purpose`、`expectedGrain`、`expectedShape` 必填并接受运行时校验。Phase 3 保存这些字段但不判断 JOIN 基数；Phase 4 的 ResultQuality 消费它们。

### 4.2 QueryArtifact v1

```ts
interface QueryArtifactV1 {
    id: string;
    generationId: string;
    userId: number;
    conversationId: string;
    datasourceId: number;
    title: string;
    plan: QueryPlanV1;
    originalSql: string;
    executedSql: string;
    schemaContextVersion: string;
    columns: Array<{ name: string; type: 'number' | 'string' | 'date' | 'boolean' | 'unknown' }>;
    returnedRowCount: number;
    totalRowCount?: number;
    isLimited: boolean;
    resultContentHash: string;
    createdAt: string;
    expiresAt?: string;
}
```

Repository 读取结果时返回：

```ts
interface QueryArtifactResultV1 {
    artifact: QueryArtifactV1;
    rows: Array<Record<string, unknown>>;
}
```

Phase 3 v1 将结果行保存为 PostgreSQL JSONB，受现有查询行数和字符上限保护。不得把 JSONB 结果重复注入 generation trace。若未来迁移对象存储，由 storage adapter 产生 `resultStorageRef`，不改变 Artifact ID 和元数据契约。

`datasourceId` 必须保存执行时解析后的真实数据源 ID；generation 中的 null/default 选择不能原样写成无法审计的 null。

`totalRowCount` 只有专门的计数查询且 QueryPlan 明确声明统计对象时才能填写；普通结果即使看起来未截断也默认不推导 total，更不得使用可见数组长度猜测总量。

### 4.3 ChartArtifact v1

```ts
interface ChartArtifactV1 {
    id: string;
    generationId: string;
    queryArtifactId: string;
    chartType: 'line' | 'bar' | 'pie' | 'scatter' | 'radar' | 'funnel';
    title: string;
    xField: string;
    yFields: Array<{ field: string; label: string }>;
    filters?: Array<{ field: string; operator: string; value: unknown }>;
    sort?: Array<{ field: string; direction: 'asc' | 'desc' }>;
    createdAt: string;
}
```

`generate_chart` 不再接受 `xAxis` 和数值 `series`。服务端校验字段存在、类型可用、Artifact 属于当前 user/conversation 且 datasource 授权仍有效，并从 Query Artifact 结果构造现有前端 `chartData`。Query Artifact 可以来自当前 generation，也可以来自同 conversation 的历史 completed Turn；Chart Artifact 的 `generationId` 始终记录当前生成任务。

### 4.4 ConversationTurn v1

```ts
interface ConversationTurnV1 {
    id: string;
    conversationId: string;
    sequence: number;
    generationId: string;
    userMessageId: string;
    assistantMessageId: string;
    status: 'pending' | 'completed' | 'failed' | 'cancelled';
    finalAnswer: string | null;
    createdAt: string;
    completedAt: string | null;
}
```

Turn 与 generation 一对一，`(conversationId, sequence)` 唯一。Artifact 通过 generation/turn 关联表查询，不在 Turn 中维护易漂移的 ID 数组。

## 5. 数据库合同

新增表：

- `conversation_turn`
- `query_artifact`
- `chart_artifact`

最低约束：

- generation、message、conversation、datasource 外键明确删除策略。
- `conversation_turn.generation_id` 唯一。
- `conversation_turn(conversation_id, sequence)` 唯一。
- `chart_artifact.query_artifact_id` 必须存在。
- Artifact 必须保存 `user_id`、`conversation_id`、`datasource_id`，读取时同时校验当前用户权限。
- Query Artifact 元数据与结果 JSONB 在同一事务提交。
- `result_content_hash` 对规范化 rows 计算，用于双写一致性与审计，不作为授权凭据。

历史迁移规则：

- 从现有 generation/message 回填 Turn，保留原 generation 状态与消息关系。
- 历史 Turn 的 sequence 按 generation `created_at,id` 稳定排序。
- 不从历史 blocks 创建 Artifact；历史 Turn 允许零 Artifact。
- 迁移必须幂等，重复执行不改变已分配 sequence 和 Artifact。

## 6. 工作包与合并顺序

### WP0：ORC-04 收尾

- 修复空 stream completed。
- 统一 Agent Loop 的失败表达：选择“返回判别联合”或“异常 + 外层归一化”之一，不保留双重语义。
- 增加完整 mock LLM 集成测试。

### WP1：Contracts 与数据库

- 在 `@gist/contracts` 定义 v1 类型和稳定错误码。
- 增加幂等迁移与历史 Turn 回填测试。
- 只建表，不改变现有读取或 UI。

### WP2：Query Artifact 双写

- SQL 成功后先持久化 Query Artifact，再发送 table event。
- SQL Executor 返回 PostgreSQL field metadata，并规范化为 `number/string/date/boolean/unknown`；numeric/bigint 等驱动字符串只有在可有限、无精度损失转换时才能作为 chart number，其他情况保留 string/unknown。
- 持久化失败时工具失败，不允许只显示无法追溯的表格。
- `blocks` 继续写入；增加 block/artifact hash 一致性测试。

### WP3：Chart Artifact

- 发布新版 `generate_chart` 参数。
- 服务端从 Query Artifact 生成 chart data。
- 模型提交未知字段、跨 conversation Artifact 或不兼容类型时拒绝。
- `toolset` 版本提升。

### WP4：Turn Context

- generation 创建时创建 pending Turn，finalize 时在同一事务更新状态和 final answer。
- PromptBuilder 只消费 completed Turn；failed/cancelled Turn 默认不进入模型历史。
- 预算不足时按 `full -> structured summary -> omit` 整 Turn 降级。
- 历史无 Artifact Turn 仍可使用最终文本，但必须标记无可复用数据证据。

### WP5：Artifact Read 与后续追问

- 增加受权限保护的 Artifact repository/read tool。
- 返回摘要、列和受限样本；默认不把完整结果重新塞入 Prompt。
- 撤权、conversation 不匹配、过期或不存在时使用稳定错误码。
- Orchestrator 只有在授权读取成功后才把历史 Artifact 视为当前 generation 的可用查询证据；仅由模型提供 Artifact ID 不得解锁 chart。

### WP6：Capability 与预算

- 建立 model capability registry。
- 计算 system、history、tool schema 和 Artifact 摘要 token。
- 对至少两种不同 context window 配置做边界测试。
- 只建立 Schema 目录/详情加载接口；召回调优留给 Phase 6。

合并顺序必须为 `WP0 -> WP1 -> WP2 -> WP3 -> WP4 -> WP5 -> WP6`。SEC-01 可与 WP1～WP6 并行，但不得绕过各自测试门禁。

## 7. 双写、开关与回滚

引入独立开关：

- `ARTIFACT_DUAL_WRITE_ENABLED`
- `ARTIFACT_CHART_READ_ENABLED`
- `TURN_CONTEXT_READ_ENABLED`

上线顺序：建表与回填 → 开启 Query 双写 → 观察一致性 → 开启 Chart Artifact 读取 → 开启 Turn Context 读取。禁止同一次部署同时首次开启全部开关。

回滚规则：

- 关闭读取开关即可恢复 blocks/message 路径；不得删除已写 Artifact。
- 双写失败率超过阈值时关闭双写并停止 Phase 3 发布，不能静默降级为“只有 block 成功”。
- 回滚代码必须能忽略新表和新字段；迁移默认前向兼容，不执行破坏性 down migration。
- 旧 `generate_chart` 参数仅在迁移窗口兼容；兼容层必须由 toolset version 控制并记录移除日期。

## 8. 自动化测试合同

新增建议入口：

- `test:phase3-migrations`
- `test:phase3-artifacts`
- `test:phase3-context`
- `smoke:phase3`

最低测试矩阵：

| 类别           | 必测场景                                                       |
| -------------- | -------------------------------------------------------------- |
| 迁移           | 空库、已有数据、重复执行、历史 failed/cancelled generation     |
| Query Artifact | 原 SQL/修复 SQL、空结果、截断、持久化失败、hash 一致性         |
| Chart          | 合法映射、未知字段、长度生成、跨用户/会话引用、过期 Artifact   |
| Turn           | completed-only、整轮裁剪、稳定 sequence、重连 snapshot、retry  |
| 权限           | datasource 撤权、conversation 不属于用户、Artifact ID 猜测攻击 |
| 预算           | 两种窗口、工具 schema 计费、Artifact 摘要过大、整 Turn 降级    |
| 可靠性         | 取消/超时期间 Artifact 写入、终态写栅栏、重复队列投递          |
| 兼容           | blocks 与 Artifact 双写、旧历史无 Artifact、开关逐项回滚       |

完整验收继续运行 Phase 0～2 回归、全仓 typecheck/build、analytics benchmark 和真实 API/Worker smoke。浏览器交互验收由用户执行，自动化必须提供可检查的 API/数据库证据。

## 9. 完成门禁（Definition of Done）

Phase 3 只有同时满足以下条件才能标记完成：

1. ORC-04 完成且所有旧回归通过。
2. 新表迁移、历史 Turn 回填和重复执行测试通过。
3. 每个新查询 table block 都能关联唯一 Query Artifact；双写一致性为 100%。
4. 每个新图表都引用 Query Artifact，模型不再提交数值数组。
5. 跨用户、跨 conversation、撤权和过期 Artifact 读取全部被拒绝。
6. PromptBuilder 不产生孤立 user/assistant 半回合。
7. returned/total/limited 语义有自动化测试且 UI/回答不混淆。
8. 两种模型窗口配置均不超窗，并证明按整 Turn 降级。
9. SSE 重连、generation retry、取消、超时和重复投递没有破坏 Artifact/Turn 一致性。
10. 回滚开关经过测试，关闭新读取路径后旧 blocks/message 路径仍可用。
11. `promptPolicy`、`toolset`、`contextPolicy`、`schemaContext` 按实际变更提升版本。
12. 更新路线图、专题状态和 Phase 3 实施记录，列出测试证据与遗留项。

## 10. 已关闭的 Phase 3 v1 设计决策

- **保留与删除**：Artifact 默认与 conversation 同寿命；删除 conversation 或用户时数据库级联物理删除。Phase 3 不启用自动 TTL，`expiresAt` 仅为未来保留策略预留。Phase 6 再引入可配置保留期和清理任务。
- **JSONB 上限**：规范化结果 JSON 单 Artifact 最大 5 MiB；超限返回稳定错误码 `ARTIFACT_RESULT_TOO_LARGE`，要求模型缩小字段、粒度或时间范围，不保存不完整证据冒充完整结果。
- **`totalRowCount`**：Phase 3 v1 默认不填写。只有专门的计数查询且 QueryPlan 明确声明统计对象时才能填写；普通数组长度、LIMIT 或字符截断都不能推导 total。
- **Chart 字段类型**：line/bar 的 y、pie/funnel 的 value、scatter 的 x/y、radar 的 value 必须是数值字段；pie/funnel 只允许一个数值字段；label/x 字段允许 string/date/number。无法确定类型时拒绝并要求重新查询或显式转换。
- **旧图表协议**：新协议使用 `toolset-v3`。`toolset-v2` 的 `xAxis/series` 兼容一个发布周期，只用于读取/重放旧 generation；新 generation 不得生成旧参数。兼容代码在 `toolset-v4` 前删除。
- **Artifact Read**：默认返回 columns、元数据和原查询顺序的前 100 行；不承诺无 ORDER BY 查询跨执行的顺序稳定性。读取继承当前 datasource 权限，不扩大现有字段可见范围；Phase 4 上线字段脱敏后同样作用于 Artifact Read。

任何需要改变上述决策的实现必须先更新本合同并说明迁移和兼容影响。

## 11. 文件与模块落点

| 工作包 | 主要文件/模块                                                                                      | 预期职责                               |
| ------ | -------------------------------------------------------------------------------------------------- | -------------------------------------- |
| WP0    | `apps/worker/src/chat/chat.service.ts`、`agent-orchestrator.ts`、Phase 2 regression                | 统一循环出口并补 mock LLM 测试         |
| WP1    | `packages/contracts/src/index.ts`、`apps/api/scripts/init-db.ts`                                   | v1 类型、错误码、三张表和幂等回填      |
| WP2    | `packages/database/src/index.ts`、`sql-executor.ts`、`sql-query.tool.ts`、新增 Artifact repository | 字段类型、结果持久化、hash 和双写      |
| WP3    | `generate-chart.tool.ts`、ToolRegistry、Prompt、前端 chart block                                   | Artifact 字段映射和兼容协议            |
| WP4    | API/Worker generation service、conversation service、PromptBuilder                                 | Turn 创建/finalize、历史读取和整轮裁剪 |
| WP5    | 新增 Artifact read tool/service、Orchestrator                                                      | 授权读取、历史证据和状态转换           |
| WP6    | `token-estimator.ts`、PromptBuilder、新增 capability/schema context service                        | 实际预算和目录/详情加载接口            |

新增模块命名可以按仓库约定调整，但职责边界不能合并回单个 ChatService。数据库读写、授权、上下文选择和图表构造必须保持可独立测试。
