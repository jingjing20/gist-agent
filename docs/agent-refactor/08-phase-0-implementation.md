# Phase 0 实施记录：可比较基线

> 实施日期：2026-09-16
>
> 状态：代码完成；已在运行中的 API/Worker/Redis/PostgreSQL 环境完成验证

## 1. 本阶段目标

在修改 Agent 行为前，建立可以识别“哪个版本产生了哪次回答”的运行基线，并补齐稳定错误码和首响应指标。

## 2. 已完成内容

### 2.1 统一运行版本

在 `packages/contracts/src/index.ts` 新增 `AGENT_RUNTIME_VERSIONS`：

- `promptPolicy`
- `toolset`
- `contextPolicy`
- `memoryPolicy`
- `schemaContext`

API 创建 generation 时同时固化：

- `model_provider`
- `model_name`
- 上述五类策略版本

这些字段是后续离线评测、线上追踪和回归对比的关联键。

### 2.2 结构化错误码

新增 `GenerationErrorCode`，首批包含：

- `ANALYSIS_TIMEOUT`
- `CANCELLED`
- `WRITER_OWNERSHIP_LOST`
- `GENERATION_CAPACITY_UNAVAILABLE`
- `MAX_AGENT_ITERATIONS_EXCEEDED`
- `LLM_REQUEST_FAILED`
- `TOOL_EXECUTION_FAILED`
- `WORKER_LOST`
- `INTERNAL_ERROR`

Worker 终止 generation 时同时写入 `error`（用户可读信息）和 `error_code`（机器稳定分类）。SSE error/done 事件同步携带 `errorCode`。

当前只完成基础分类。工具内部错误细分、最大轮次错误和供应商错误映射将在显式状态机阶段继续接入。

### 2.3 首响应指标

首个有效 LLM delta 到达后写入：

- `generation.first_token_at`
- `generation_attempt.received_first_delta`

指标写入失败只记录 warning，不中断用户生成任务。

### 2.4 回归入口

新增快速、无外部服务依赖的回归：

```bash
pnpm test:generation-baseline
```

覆盖版本格式、错误码唯一性和错误归类优先级。

扩展现有完整链路 smoke：

```bash
pnpm smoke:agent-baseline
```

它在 API/Worker/Redis/PostgreSQL 已运行时验证：

- 多 conversation generation 能完成；
- generation 版本字段已持久化；
- completed generation 没有 error code；
- `first_token_at` 和 `received_first_delta` 已写入。

## 3. 数据库变更

`generation` 新增：

```text
error_code
model_provider
model_name
prompt_policy_version
toolset_version
context_policy_version
memory_policy_version
schema_context_version
```

现有字段 `first_token_at` 开始实际写入。迁移仍通过项目当前的幂等 `init-db` 方式执行。

## 4. 已执行验证

- `pnpm init-db`
- `pnpm typecheck`
- `pnpm test:generation-baseline`
- `pnpm test:reasoning`
- `pnpm --filter @gist/api test:init-db`
- `pnpm benchmark:analytics`：40 个 SQL case、6 个语义 case 通过
- `pnpm build`
- `pnpm smoke:agent-baseline`：2 个 conversation、2 个 generation 均 completed；版本和首 delta 指标校验通过

构建存在 Vite 对大于 500 kB chunk 的非阻塞警告，不影响本阶段验收。

## 5. 下一阶段入口

Phase 1 将处理：

1. generation 固化 request/data source/context 水位；
2. conversation 级串行约束；
3. 统一 cancellation context；
4. 超时后真正停止后台执行；
5. 终态写栅栏。
