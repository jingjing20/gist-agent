# 03. 上下文与查询 Artifact 改造

## 1. 目标

把“聊天连续性”和“分析证据连续性”分开管理：对话历史保持语义连贯，查询 artifact 保持数据可追溯，避免依赖被压缩或被模型改写的历史文本。

## 2. 当前实现证据

- 历史以数据库中的单条 user/assistant message 为单位构造 `HistoryEntry`。
- 最近消息为 full，中距为 medium，远距为 compact：`apps/worker/src/chat/prompt-builder.ts`。
- full 模式也会把工具结果脱水为行数和列名：`dehydrateToolResult`。
- medium 模式保存 SQL、返回数组长度和最终文字结论。
- 选择历史时某条放不下会 skip，并继续尝试更老消息。
- Token 预算使用固定 `MAX_CONTEXT_TOKENS`、`RESPONSE_RESERVE=4000`、`TOOLS_RESERVE=1500`。
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
  artifactIds: string[];
  createdAt: string;
  completedAt: string | null;
}
```

PromptBuilder 只消费已完成 Turn，并以 Turn 为最小裁剪单位。

### 4.2 Query Artifact

```ts
interface QueryArtifact {
  id: string;
  generationId: string;
  datasourceId: number;
  purpose: string;
  originalSql: string;
  executedSql: string;
  schemaVersion: string;
  columns: Array<{ name: string; type?: string }>;
  returnedRowCount: number;
  isLimited: boolean;
  resultStorageRef: string;
  sampleRows: unknown[];
  summary: object;
  executedAt: string;
}
```

注意区分：

- `returnedRowCount`：实际返回给应用的数量；
- `isLimited`：是否可能存在更多行；
- `totalRowCount`：只有显式 count 查询后才能填写。

### 4.3 Chart Artifact

Chart Artifact 引用 Query Artifact 和字段映射，不保存由模型重新生成的另一份数字真相。

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
  maxOutputTokens: number;
  tokenizer: string;
  supportsReasoning: boolean;
  requiresHistoricalReasoningContent: boolean;
}
```

运行时计算实际工具 schema token，不再固定预留 1500。预算不足时按整 Turn 降级：`full turn -> structured summary -> omit`，禁止拆散一轮。

## 8. 实施步骤

1. 增加 turn 与 artifact 表；先双写，不立即删除现有 `llm_messages/blocks`。
2. SQL Tool 成功后落 Query Artifact，再把 artifact ID 返回给 Agent。
3. 图表改为消费 artifact。
4. PromptBuilder 引入 `TurnContextAssembler`，先以最近完成 Turn 替代现有 message 列表。
5. 增加 artifact read 工具，支持后续追问按 ID 取样或重新聚合。
6. 引入 model capability registry 和真实 tokenizer。
7. 最后再迁移/清理旧 `llm_messages` 中不必要的大字段。

## 9. 涉及文件

- `apps/api/scripts/init-db.ts`
- `apps/worker/src/chat/prompt-builder.ts`
- `apps/worker/src/chat/token-estimator.ts`
- `apps/worker/src/chat/tools/sql-query.tool.ts`
- `apps/worker/src/chat/tools/generate-chart.tool.ts`
- `apps/worker/src/conversation/conversation.service.ts`
- `packages/contracts/src/index.ts`

## 10. 验收标准

- 上下文永远不出现孤立的 user/assistant 半回合。
- “继续分析刚才结果”能够通过 artifact 得到确定数据，而不是依赖模型记忆。
- UI 表格、最终结论和图表都能追溯到同一 Query Artifact。
- returned row count、total row count 和 truncated/limited 状态不会混淆。
- 在不同上下文窗口模型上均不会超过模型 token 上限。
- 100 张表的数据源不会将全部字段无条件塞入 System Prompt。

