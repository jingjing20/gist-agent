# 03. 上下文与查询 Artifact 改造

> 实施状态：对应 Phase 3，已完成。冻结契约见 [Phase 3 实施合同](./11-phase-3-implementation-contract.md)，实现与测试证据见 [Phase 3 实施记录](./12-phase-3-implementation.md)。
>
> 前置基础：Phase 1 已提供 generation 输入快照，Phase 2 已提供确定性工具顺序；Phase 3 在此基础上解决“合法执行之后，证据如何保存和复用”。

## 1. 目标

把“聊天连续性”和“分析证据连续性”分开管理：对话历史保持语义连贯，查询 artifact 保持数据可追溯，避免依赖被压缩或被模型改写的历史文本。

## 2. 重构前的实现证据

- 历史以数据库中的单条 user/assistant message 为单位构造 `HistoryEntry`。
- 最近消息为 full，中距为 medium，远距为 compact：`apps/worker/src/chat/prompt-builder.ts`。
- full 模式也会把工具结果脱水为行数和列名：`dehydrateToolResult`。
- medium 模式保存 SQL、返回数组长度和最终文字结论。
- 选择历史时某条放不下会 skip，并继续尝试更老消息。
- Token 预算使用固定窗口和工具预留，不按实际模型与 schema 计费。
- reasoning 模式只接受 full 历史，并丢弃缺少完整 reasoning 的旧 assistant 消息。

## 3. 问题清单

### CTX-001：消息级裁剪破坏回合完整性（P1）

user 和 assistant 独立参与预算，可能只保留问题或只保留回答；skip 策略还可能造成时间线中间缺口。

### CTX-002：最近证据被过度脱水（P1）

用户追问“刚才第三项”“用上次结果换个维度画图”时，模型只剩列名和行数，无法可靠回答。

### CTX-003：数组长度被当作业务总行数（P1）

SQL 已被注入 LIMIT，工具结果又可能按字符截断。当前上下文中的 row count 只是模型可见数组长度，不一定是业务全集大小。

### CTX-004：预算配置与模型能力脱节（P1）

固定预留无法适配不同模型、不同工具数量和不同推理模式，估算误差可能导致请求超窗或过度裁剪。

### CTX-005：全量 Schema 常驻上下文难以扩展（P2）

数据源表/字段增长后，System Prompt 会挤占历史和结果预算，也会增加选错表概率。

## 4. 目标领域模型

### 4.1 Turn

```ts
interface ConversationTurn {
    id: string;
    conversationId: string;
    sequence: number;
    userMessageId: string;
    assistantMessageId: string;
    generationId: string;
    status: 'pending' | 'completed' | 'failed' | 'cancelled';
    finalAnswer: string | null;
    createdAt: string;
    completedAt: string | null;
}
```

PromptBuilder 只消费已完成的历史 Turn 和当前 pending Turn 的确切 user request，并以完整 Turn 为历史裁剪单位。

### 4.2 Query Artifact

```ts
interface QueryArtifact {
    id: string;
    generationId: string;
    userId: number;
    conversationId: string;
    datasourceId: number;
    title: string;
    plan: {
        purpose: string;
        expectedGrain: string;
        expectedShape: 'scalar' | 'timeseries' | 'category' | 'detail';
    };
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

存储位置属于 repository 实现细节，不进入模型可见契约。Phase 3 v1 使用 PostgreSQL JSONB；未来切换对象存储时保持 Artifact ID 和元数据稳定。

注意区分：

- `returnedRowCount`：实际返回给应用的数量；
- `isLimited`：是否可能存在更多行；
- `totalRowCount`：只有显式 count 查询后才能填写。

### 4.3 Chart Artifact

Chart Artifact 引用 Query Artifact 和字段映射，不保存由模型重新生成的另一份数字真相：

```ts
interface ChartArtifact {
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

服务端必须验证引用字段存在于 Query Artifact columns 中，并从 artifact 结果构造前端 chart data。模型不能提交 `xAxis` 或数值 `series` 作为新的事实副本。

## 5. 上下文组装策略

推荐按以下顺序分配预算：

1. 固定安全与分析政策；
2. 当前用户问题；
3. 当前任务状态和已产生 artifact；
4. 与问题相关的 Schema；
5. 用户确认的相关记忆；
6. 最近完整 Turn；
7. 相关历史 Turn 摘要；
8. 安全余量和回复预算。

最近 Turn 可保留：问题、最终结论、执行 SQL、artifact 引用和少量样本。更早 Turn 保存结构化摘要，不保存伪造的“完整证据”。

## 6. Schema 检索策略

采用两阶段加载：

1. 常驻精简目录：表名、业务说明、数据集、主要粒度。
2. 根据问题选择候选表后，再加载完整字段、关系、样例和口径。

候选表选择必须允许兜底扩展，避免第一次检索漏表后模型永远看不到正确 Schema。

## 7. Token 预算改造

建立模型能力配置：

```ts
interface ModelCapabilities {
    contextWindow: number;
    responseReserve: number;
}
```

运行时对实际工具 JSON schema 做统一 token 估算，不再固定预留 1500。当前估算器是保守的字符权重算法，不声称等同供应商 tokenizer；精确 tokenizer 校准可随 Phase 6 模型路由评测补充。预算不足时按整 Turn 降级：`full turn -> structured summary -> omit`，禁止拆散一轮。

## 8. 实施步骤

具体编码顺序、迁移验收和回滚条件以 [Phase 3 实施合同](./11-phase-3-implementation-contract.md) 为准。本专题固定以下顺序原则：

1. 先确定 QueryPlan/Artifact/Turn 契约和授权边界，再建表。
2. 先双写并校验一致性，不立即删除现有 `llm_messages/blocks`。
3. SQL Tool 成功后原子落 Query Artifact，再返回 artifact ID。
4. 图表改为只消费 artifact 字段映射。
5. PromptBuilder 改为按完整 Turn 组装上下文。
6. 最后接入 model capability registry、统一 token 估算和历史清理；清理必须晚于读取链路稳定。

## 9. 涉及文件

- `apps/api/scripts/init-db.ts`
- `apps/worker/src/chat/prompt-builder.ts`
- `apps/worker/src/chat/token-estimator.ts`
- `apps/worker/src/chat/tools/sql-query.tool.ts`
- `apps/worker/src/chat/tools/generate-chart.tool.ts`
- `apps/worker/src/conversation/conversation.service.ts`
- `packages/contracts/src/index.ts`

## 10. 为什么现在需要做

Phase 2 能证明“先成功查询、再生成图表”，却不能证明图表中的每个数字来自哪次查询、哪个字段。与此同时，PromptBuilder 为控制 token 会脱水工具结果；用户下一轮追问时，模型可能只剩 SQL、列名和行数，而没有刚才真正的数据。

根因是一个对象同时承担了两种职责：聊天消息既用于表达，又被当作查询证据。表达内容可以摘要，证据却不能在没有引用关系的情况下被自由压缩。Phase 3 要把两者拆开：Turn 保证对话因果完整，Artifact 保存可追溯事实。

## 11. 方案选择与取舍

### 11.1 采用 Artifact 引用，而不是永久保留完整 Prompt 历史

永久把所有查询结果放入上下文会快速耗尽 token，也会增加敏感数据暴露面。Artifact 将完整或外部化结果保存在上下文之外，Prompt 只携带摘要和稳定 ID；需要时再按权限读取。

### 11.2 采用双写迁移，而不是一次替换 `blocks/llm_messages`

现有 UI、历史消息和 SSE 恢复仍依赖 blocks。先双写 Query/Chart Artifact 可以独立验证一致性并保留回滚能力，待读取链路稳定后再清理旧大字段。

### 11.3 Chart 引用 Query Artifact，而不是保存模型复制的数组

复制数组实现简单，但会产生第二份无法证明一致的“数字真相”。Chart Artifact 应保存字段映射和展示意图，真实数据由服务端从 Query Artifact 组装。

### 11.4 以完整 Turn 为裁剪单位，而不是继续优化单消息启发式

调节 full/medium 窗口只能降低半回合概率，不能从模型上消除它。Turn 是天然的因果单位，降级时应整轮摘要或整轮移除。

### 11.5 Schema 两阶段加载可以在本阶段奠基，但规模化调优留到 Phase 6

职责边界固定为：Phase 3 只建立 `SchemaCatalogSummary`/`SchemaDetail` 契约和按需加载接口，以便上下文预算不再强依赖全量 Schema；Phase 6 才实现和调优检索排序、召回评测、缓存、成本阈值与大规模数据源策略。“100 张表召回质量”不属于 Phase 3 的完成条件。

## 12. 预期前后对比

| 场景       | 当前状态                    | Phase 3 目标                            | 预期收益                   |
| ---------- | --------------------------- | --------------------------------------- | -------------------------- |
| 多轮追问   | 依赖被压缩的消息文本        | 通过 artifact ID 读取确定结果           | “刚才第三项”不再靠模型猜测 |
| 图表数据   | 模型重新生成 `xAxis/series` | Chart Artifact 引用 Query Artifact 字段 | 图表和表格共享同一事实源   |
| 上下文裁剪 | user/assistant 分别参与预算 | 完整 Turn 降级                          | 不出现孤立问题或孤立回答   |
| 行数语义   | 可见数组长度可能被误作总量  | returned/limited/total 明确区分         | 防止把截断样本解释成全集   |
| 模型窗口   | 固定预留和估算              | capability registry + 实际 schema 计费  | 减少超窗和过度裁剪         |

## 13. 非目标、风险与实施门槛

- Artifact 解决证据身份，不自动证明 SQL 口径正确；ResultQuality 属于 Phase 4。
- QueryPlan 的最小字段（purpose、expectedGrain、expectedShape）已在 Phase 3 定义并随 Query Artifact 保存；涉及表、复杂 JOIN 基数与质量规则由 Phase 4 扩展。
- Artifact 不能绕过权限。读取、保留和删除都必须继承 datasource/user 授权，并定义清理策略。
- 不在本阶段建立长期业务记忆；稳定口径治理属于 Phase 5。
- 双写期间必须增加一致性校验，防止 blocks 与 artifact 静默分叉。
- 在删除旧字段前，必须证明历史会话、SSE snapshot 和 UI 渲染均已切换并具备回滚路径。

## 14. 专题最终验收标准

- 上下文永远不出现孤立的 user/assistant 半回合。
- “继续分析刚才结果”能够通过 artifact 得到确定数据，而不是依赖模型记忆。
- UI 表格、最终结论和图表都能追溯到同一 Query Artifact。
- returned row count、total row count 和 truncated/limited 状态不会混淆。
- 在不同上下文窗口模型上均不会超过模型 token 上限。
- Phase 3 已建立目录/详情接口契约；Prompt 真正切换为按需检索、100 张表规模的召回质量和成本阈值由 Phase 6 验收。
