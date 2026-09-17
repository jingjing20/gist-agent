# Phase 1 决策与实施记录：可靠性止血

> 实施日期：2026-09-16
>
> 状态：核心能力已完成；stale writer 等自动化故障场景通过，真实 Worker 进程 kill/recovery 测试由 EVAL-02 承接
>
> 对应问题域：[执行与并发可靠性](./01-execution-reliability.md)

## 1. 阶段结论

Phase 1 把 generation 从“读取会话当前状态并尽力生成”改造成“使用不可变输入、在单一取消域内执行、受 writer 身份保护、以终态为副作用边界”的任务。它优先解决串话、错数据源和任务失败后继续运行这类会产生错误结果或幽灵写入的问题。

## 2. 重构前为什么不可靠

### 2.1 请求输入不是快照

Worker claim 任务后重新读取会话当前数据源和“最后一条 user message”。同一 conversation 如果连续提交请求或切换数据源，较早的 generation 可能使用较晚请求的输入。

这不是偶发 UI 问题，而是因果关系错误：数据库里记录的是 generation A，实际执行的却可能是请求 B 或数据源 B。

### 2.2 超时只结束等待，不结束工作

原实现依赖 `Promise.race` 返回超时，但底层 LLM、工具或 PostgreSQL 查询可能仍在运行。外层已经写入 failed 后，后台协程仍可能继续发 SSE、更新消息或占用数据库资源。

### 2.3 终态不是统一写边界

事件发布、checkpoint、工具执行和最终消息更新使用分散检查，没有同时证明“writer 仍拥有任务且 generation 尚未终止”。重复队列投递、Worker 停顿或租约丢失时，旧执行者可能继续写入。

### 2.4 根因

- generation 没有完整拥有自己的不可变输入，运行时仍依赖 conversation 可变状态。
- 取消被当作外层控制流结果，而不是贯穿整个调用树的执行信号。
- writer ownership 和 terminal status 没有形成每个副作用都必须通过的统一 guard。

## 3. 方案选择与取舍

### 3.1 Conversation 并发策略

采用“同一 conversation 最多一个 active generation”，而没有立即实现并行分支。线性会话中两个并行回答没有稳定的父子顺序；在缺少 `parent_message_id` 分支语义时，直接并发只会把歧义推给模型。不同 conversation 仍可并行。

### 3.2 取消策略

采用一个 `AbortController` 贯穿 LLM、Tool 和 SQL，并规定“先 abort、等待执行栈退出、再 finalize”。没有继续使用 `Promise.race` 作为取消机制，因为它只能停止等待者，不能停止被等待的工作。

### 3.3 Writer 一致性策略

采用数据库 writer token + active status 条件作为最终写栅栏，而不是只依赖 Redis lease。Redis 适合协调容量和队列，但数据库才是 generation/message 的事实源；副作用提交必须和事实源状态一致。

### 3.4 SQL 终止策略

采用独立只读事务、`statement_timeout` 和 `pg_cancel_backend`。只设置 JavaScript 定时器无法释放 PostgreSQL 后端执行；只关闭共享连接又会影响无关请求。

## 4. 重构后的关键不变量

1. Worker 只使用 generation 创建时固化的 request、datasource 和上下文水位。
2. 同一 conversation 最多只有一个 active generation。
3. 超时、用户取消和 writer 丢失共用同一 `AbortSignal`。
4. 普通事件、checkpoint 和消息写入必须同时满足 writer token 匹配且 generation 非终态。
5. 只有执行栈退出后才能写终态；终态后旧 Worker 无法继续产生副作用。

## 5. 最终实现

### 5.1 Generation 输入快照

`generation` 新增 `datasource_id`、`context_upper_bound` 和 `parent_message_id`。API 在 conversation 事务锁内一次性固化字段。Worker 通过 `request_message_id` 读取精确请求，不再读取“最后一条 user message”或 conversation 当前数据源；retry 沿用原快照。

PromptBuilder 只加载水位之前已 completed 的 generation request/response，再加入当前精确 request。`contextPolicy` 提升为 `context-policy-v2`。

### 5.2 Conversation 串行

- API 使用 conversation UUID 的 PostgreSQL advisory transaction lock 串行创建。
- active status 部分唯一索引作为数据库最终防线。
- 已有活动任务时返回 `409 / CONVERSATION_GENERATION_ACTIVE`。
- Web 将 409、429 转成明确、可操作的提示。

### 5.3 统一取消与 SQL 真终止

- 超时先调用 `AbortController.abort()`，执行栈退出后再 finalize。
- `ToolContext` 携带 `signal` 与 `assertWritable()`。
- SQL 在独立 PostgreSQL 只读事务中设置 `SET LOCAL statement_timeout`。
- signal 触发 `pg_cancel_backend`。
- cancelled/failed generation 不再启动 semantic memory 蒸馏。

### 5.4 Writer/terminal 写栅栏

- Redis 普通事件发布前锁定 generation，校验 writer token 与 active status。
- checkpoint 使用相同条件更新 message。
- 最终 message 与 generation terminal status 在同一数据库事务提交。
- Redis 发布设置 command timeout，避免故障时无限持有 generation 行锁。
- 重复投递只有一个 writer 能 claim；心跳失效后旧 writer 的写入被拒绝。

## 6. 重构前后对比

| 场景                 | 重构前                       | 重构后                           | 直接收益                         |
| -------------------- | ---------------------------- | -------------------------------- | -------------------------------- |
| 请求识别             | 从会话中推断最后一条用户消息 | generation 固化 request ID       | 并发或延迟 claim 不会拿错问题    |
| 数据源               | 执行时读取会话当前值         | 创建任务时固化                   | 切换数据源不影响排队任务         |
| 上下文               | 可能混入未完成或失败回合     | 水位前 completed-only + 当前请求 | 避免串话和半成品污染             |
| 同会话并发           | 多个任务竞争线性历史         | advisory lock + 唯一索引         | 因果顺序确定，冲突显式返回       |
| 超时/取消            | 外层停止等待，底层可能继续   | signal 贯穿 LLM、工具和 SQL      | 真正释放执行资源，避免迟到副作用 |
| 重复投递/Worker 丢失 | 旧执行者可能继续写           | writer token + terminal guard    | 单 writer、终态后零普通写入      |

这套方案更好的原因是把可靠性从“每层尽量检查”变成了两个可证明边界：不可变输入决定任务读什么，writer/terminal guard 决定任务还能写什么。

## 7. 迁移、兼容与回滚

- `init-db` 为旧 generation 回填 conversation 数据源和 `created_at` 水位，之后将水位设为 `NOT NULL`。
- 已有消息和成功响应格式保持兼容；新增 409 是更严格但可识别的行为。
- 回滚代码时新列可保留。
- 若必须恢复同会话并发，需要删除 `uk_generation_conversation_active`；在没有显式分支模型前不建议这样做。

## 8. 验证证据

专项入口：

```bash
pnpm test:phase1-reliability
```

覆盖 conversation 409、输入快照、completed-only 上下文、终态写栅栏、重复投递、模拟 Worker 心跳丢失（`failStale`）、Redis 写暂停、LLM 卡死、用户取消、SQL timeout 和后端取消，并确认 abort 后只有 terminal 事件且不触发 semantic memory。

完整验证还包括：

- `pnpm init-db`
- `pnpm typecheck`
- `pnpm build`
- `pnpm test:generation-baseline`
- `pnpm test:reasoning`
- `pnpm --filter @gist/api test:init-db`
- `pnpm benchmark:analytics`：40 个 SQL case、6 个语义 case 通过
- `pnpm smoke:agent-baseline`：2 个 conversation 并行、2 个 generation 均 completed

首次 smoke 暴露出当时环境中 Nest watch 外层存活但 Worker 子进程退出的问题。现场证据显示 outbox 已发布但 attempt 为 0；重启 Worker 后通过。这一记录说明 smoke 同时验证了“进程存活”和“任务真正被消费”之间的差异。

该现场故障不是可重复的自动化 Worker kill 测试。真实启动进程、SIGKILL、stale recovery、旧 writer 拒写和任务最终终态的端到端场景仍由 EVAL-02 承接。

## 9. 边界与遗留问题

- 同 conversation 采用拒绝并发，不等于已经支持分支会话。
- 输入和副作用已经确定，但模型仍可提出非法工具顺序或无效参数。
- `MAX_AGENT_ITERATIONS` 的明确失败码已预留，但完整 outcome 和状态机留到 Phase 2。
- 数据库只读事务提高了单次查询安全性，独立最小权限账号和完整 fail-closed 仍属于 Phase 4。

## 10. 下一阶段为什么是 Phase 2

Phase 1 保证任务不会串话、不会在“死后”继续写，但任务活着时的控制流仍主要依赖 Prompt。下一步必须把工具参数、调用顺序和退出结果收进代码，才能让一次可靠执行同时也是一次确定性执行。
