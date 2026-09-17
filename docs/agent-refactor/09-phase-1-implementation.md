# Phase 1 实施记录：可靠性止血

> 实施日期：2026-09-16
>
> 状态：代码完成；已在运行中的 API/Worker/Redis/PostgreSQL 环境完成故障注入与端到端验证

## 1. 实施后的不变量

1. Worker 只使用 generation 创建时固化的 request、datasource 和上下文水位。
2. 同一 conversation 最多只有一个 active generation。
3. 超时、用户取消和 writer 丢失共用同一 `AbortSignal`。
4. 普通事件、checkpoint 和消息写入必须同时满足 writer token 匹配且 generation 非终态。
5. 只有当执行栈退出后才写终态；终态后旧 Worker 无法继续产生副作用。

## 2. Generation 输入快照

`generation` 新增 `datasource_id`、`context_upper_bound` 和 `parent_message_id`。API 在 conversation 事务锁内一次性固化这些字段。Worker 通过 `request_message_id` 读取精确请求，不再使用“最后一条 user message”，也不再从 conversation 读取可变数据源。retry 同样沿用原 generation 的数据源快照。

PromptBuilder 的 generation 路径只读取水位之前已 completed generation 的 request/response，再加当前 generation 的精确 request message。`contextPolicy` 已提升为 `context-policy-v2`。

## 3. Conversation 串行

- API 使用 conversation UUID 的 PostgreSQL advisory transaction lock 串行创建。
- 数据库增加 active status 部分唯一索引作为最终防线。
- 同一 conversation 已有任务时 API 返回 `409 / CONVERSATION_GENERATION_ACTIVE`。
- Web 端将 409 和 429 转成明确的可操作提示。

## 4. 结构化取消与 SQL 真终止

- 全局超时改为先 `AbortController.abort()`，等 Agent Loop 退出后再 finalize。
- `ToolContext` 新增 `signal` 和 `assertWritable()`，贯穿所有工具。
- SQL 在独立的 PostgreSQL 只读事务内运行，使用 `SET LOCAL statement_timeout`。
- AbortSignal 触发 `pg_cancel_backend`，不再使用不会停止后台查询的 `Promise.race`。
- 取消和失败不再触发 semantic memory 蒸馏。

## 5. Writer/terminal 写栅栏

- Redis 普通事件发布前在事务内锁定 generation 并校验 writer token 与 active status。
- checkpoint 使用同样的 writer/status 条件更新 message。
- 最终 message 与 generation 终态在同一数据库事务中写入。
- Redis 发布增加 5 秒 command timeout，避免 Redis 故障时无限持有 generation 行锁。
- 重复队列投递只有一个 writer 能 claim；Worker 心跳超时后旧 writer 的事件和 checkpoint 都会被拒绝。

## 6. 迁移与兼容

- `init-db` 会为旧 generation 回填 conversation 数据源和 `created_at` 上下文水位。
- 上下文水位回填后设为 `NOT NULL`。
- 已有消息/API 响应格式保持兼容；新的 409 错误码是增量行为。
- 回滚代码时可保留新列。若必须恢复同会话并发，需先删除 `uk_generation_conversation_active`，但不建议这样做。

## 7. 专项故障回归

```bash
pnpm test:phase1-reliability
```

已验证 conversation 409 串行、输入快照、completed-only 上下文隔离、终态写栅栏、重复投递、Worker 心跳丢失、Redis `CLIENT PAUSE WRITE`、LLM 卡死超时、用户取消、SQL statement timeout 和 AbortSignal 后端取消。测试同时确认 abort 后只产生 terminal 事件，不触发 semantic memory。

## 8. 完整验证

- `pnpm init-db`
- `pnpm typecheck`
- `pnpm build`
- `pnpm test:phase1-reliability`
- `pnpm test:generation-baseline`
- `pnpm test:reasoning`
- `pnpm --filter @gist/api test:init-db`
- `pnpm benchmark:analytics`：40 个 SQL case、6 个语义 case 通过
- `pnpm smoke:agent-baseline`：2 个 conversation 并行、2 个 generation 均 completed

端到端 smoke 首次执行时发现当时环境的 Nest watch 外层进程存活、Worker 子进程已退出。保留现场的最小诊断证明 outbox 已发布但 attempt 为 0；重启 Worker 后 smoke 通过。诊断临时数据与脚本已清理。

## 9. 下一阶段入口

Phase 2 将处理明确 Agent outcome、迭代耗尽、工具参数运行时校验和状态机。
