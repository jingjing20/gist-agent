# 01. 执行与并发可靠性改造

> Phase 1 已完成本文的输入快照、conversation 串行、结构化取消、SQL 真终止和 writer/terminal 写栅栏。实施与验证记录见 [Phase 1 实施记录](./09-phase-1-implementation.md)。迭代耗尽已在 Phase 2 实现；空回答与完整循环出口测试列为 ORC-04 收尾项。
>
> 阅读提示：下文“Phase 1 前的基线证据”和“问题清单”记录的是历史基线，用于说明决策原因，不代表当前代码仍存在这些问题。

## 1. 目标

确保每个 generation 使用确定的输入、只产生一条因果一致的输出，并且超时、取消、租约丢失或 Worker 异常后不会继续产生副作用。

## 2. Phase 1 前的基线证据

- API 在事务中创建 user message、assistant 占位、generation 和 outbox：`apps/api/src/chat/generation.service.ts`。
- Worker 通过 `generation.id` 领取任务并获取会话当前的 `datasource_id`：`apps/worker/src/chat/generation.service.ts`。
- Worker 随后读取整个会话，并用“最后一条 user message”作为本轮 message（历史基线；当前代码已移除该行为）。
- 构建上下文时只排除当前 response message（历史基线；当前 generation 路径已改为水位与 completed generation 约束）。
- 用户级并发默认允许 5 个 generation，但没有 conversation 级互斥（历史基线）。
- 全局超时由 `Promise.race` 实现，超时分支不调用 `AbortController.abort()`（历史基线）。
- SQL 的 15 秒超时同样是 `Promise.race`，不会终止 PostgreSQL 后端查询（历史基线）。
- 循环达到 `MAX_AGENT_ITERATIONS` 后函数自然返回，外层会按 completed finalize。

## 3. 问题清单

### REL-001：超时后执行协程继续运行（P0）

风险：generation 已失败，但 LLM、SQL、SSE 和 checkpoint 仍可能继续。最终消息可能被后台协程再次覆盖。

### REL-002：同一 conversation 并发导致上下文串话（P0）

风险：两个请求可能都看到彼此尚未完成的 user message 和 assistant 占位，模型无法判断哪个问题属于自己。

### REL-003：数据源是会话可变状态，不是 generation 快照（P0）

风险：后一个请求修改 `conversation.datasource_id` 后，先前尚未 claim 的 generation 可能使用错误数据源。

### REL-004：最大轮次耗尽被视为成功（P0）

风险：只有工具调用、没有最终文字结论的消息也会标记 completed。

### REL-005：取消不能贯穿工具层（P1）

`AbortSignal` 传递给 LLM，但没有进入 `ToolContext` 和数据库执行层。长 SQL 期间取消只能等待查询自然结束。

### REL-006：终态缺少统一写栅栏（P1）

事件发布、checkpoint、消息更新和工具执行分别检查不同状态，缺少“仍然拥有 generation 且尚未终态”的统一 guard。

## 4. 目标设计

### 4.1 固化 GenerationInput

在 `generation` 中保存或关联不可变输入：

```ts
interface GenerationInput {
    generationId: string;
    requestMessageId: string;
    responseMessageId: string;
    conversationId: string;
    userId: number;
    datasourceId: number | null;
    contextUpperBound: string; // message sequence 或 turn sequence
    parentMessageId: string | null;
    reasoningEnabled: boolean;
    promptPolicyVersion: string;
}
```

Worker 必须按 `request_message_id` 读取问题，并只加载 `contextUpperBound` 之前的已完成回合。不得再次从 conversation 的可变字段推断本轮输入。

### 4.2 Conversation 串行策略

第一阶段采用简单策略：同一个 conversation 同时只允许一个 active generation。

- 数据库增加部分唯一索引，或使用 conversation advisory lock。
- API 收到第二个请求时返回 409/429，前端提示等待或取消当前任务。
- 用户仍可在不同 conversation 并行分析。

若未来需要对话分支，应显式增加 `parent_message_id` 和 branch，而不是让两个生成共享一条线性历史。

### 4.3 结构化取消域

建立一个贯穿整轮执行的 `GenerationExecutionContext`：

```ts
interface GenerationExecutionContext {
  identity: GenerationIdentity;
  signal: AbortSignal;
  assertWritable(): Promise<void>;
  checkpoint(...): Promise<void>;
}
```

所有 LLM、Tool、SQL、事件发布、消息写入之前执行 `assertWritable()`。超时、用户取消、租约续期失败都会触发同一个 controller。

### 4.4 真正终止 SQL

优先选择 PostgreSQL 原生机制：

- 在只读事务中执行 `SET LOCAL statement_timeout`；
- 每轮查询使用可识别的独立 connection；
- 取消时调用驱动支持的 cancel，或关闭专用连接；
- `Promise.race` 只作为上层兜底，不作为取消实现。

### 4.5 明确循环终态

Agent Loop 返回判别联合类型：

```ts
type AgentOutcome =
    | { kind: 'completed'; finalText: string }
    | { kind: 'needs_clarification'; question: string }
    | { kind: 'cancelled' }
    | { kind: 'iteration_exhausted'; diagnostics: object }
    | { kind: 'failed'; error: Error };
```

仅 `completed` 且具备最终回答时可写入 completed。

## 5. 实施步骤

1. 数据库迁移：为 generation 增加 `datasource_id`、`context_upper_bound`、`parent_message_id`、`prompt_policy_version`。
2. API 创建任务时一次性写入全部不可变输入。
3. `GenerationService.candidate/claim` 返回 `request_message_id` 和 generation 自身的数据源。
4. PromptBuilder 增加 `upperBound`/`completedOnly` 查询条件。
5. 增加 conversation 级 active generation 约束。
6. 将 signal 加入 `ToolContext`，逐层传递到 SQL Executor。
7. 重写超时处理：abort -> 等待协程退出 -> 最后 checkpoint -> finalize。
8. publish/checkpoint 增加 writer token 与非终态条件。
9. 对 iteration exhausted 建立明确错误码和前端展示。

## 6. 涉及文件

- `apps/api/scripts/init-db.ts`
- `apps/api/src/chat/generation.service.ts`
- `apps/api/src/chat/chat.service.ts`
- `apps/worker/src/chat/generation.service.ts`
- `apps/worker/src/chat/chat.service.ts`
- `apps/worker/src/chat/tools/base-tool.ts`
- `apps/worker/src/chat/agents/sql-executor.ts`
- `apps/worker/src/conversation/conversation.service.ts`
- `packages/contracts/src/index.ts`
- `apps/web/src/stores/chat.ts`

## 7. 验收标准

- 同一 conversation 同时提交两个请求时，系统明确拒绝/排队，不发生串话。
- 修改当前会话数据源不影响已创建 generation 的数据源。
- 超时或取消后不再出现 SQL、普通 SSE、checkpoint 或消息内容变化。
- Worker 租约丢失后，旧 Worker 无法继续写入。
- 15 轮耗尽返回明确失败；空 LLM 响应不得产生 completed 消息（后半项由 ORC-04 承接）。
- 自动化故障测试覆盖：LLM 卡死、SQL 卡死、Redis 暂停、stale writer/心跳丢失、重复队列投递。
- 真实 Worker 进程 kill、任务回收与旧进程写栅栏需由 EVAL-02 端到端场景覆盖。
