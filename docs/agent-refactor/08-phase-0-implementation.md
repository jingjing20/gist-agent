# Phase 0 决策与实施记录：建立可比较基线

> 实施日期：2026-09-16
>
> 状态：已完成；已在运行中的 API、Worker、Redis、PostgreSQL 环境验证
>
> 对应问题域：[评测与可观测性](./06-evaluation-and-observability.md)

## 1. 阶段结论

Phase 0 不直接改变 Agent 的分析能力，而是先让每次回答能够被归因、失败能够被稳定分类，并建立确定性回归和真实链路 smoke。这是 Phase 1 之后可靠性改造的测量基线；真实 Agent 逐 case 质量评分不属于本阶段完成范围，由 EVAL-01 承接。

## 2. 为什么必须先做

### 2.1 重构前的状态

- generation 没有完整记录模型、Prompt、工具、上下文和记忆策略版本。
- 错误主要依赖中文文本，修改措辞就可能破坏聚合和前端判断。
- `first_token_at` 等字段存在但未形成可靠写入链路。
- SQL benchmark 能验证标准查询，却不能证明真实 API/Worker Agent 链路可用。

### 2.2 实际风险

- 同一问题回答变差时，无法判断是模型、Prompt、工具还是上下文策略变化导致。
- 线上错误无法稳定按类型统计，趋势数据会随着错误文案变化而漂移。
- 后续重构即使通过人工体验，也无法排除吞吐、延迟或正确率回归。
- 没有基线时直接优化 Prompt，容易把随机波动误认为工程收益。

### 2.3 根因

系统已经有 generation 和 benchmark 的工程骨架，但缺少贯穿“配置版本 → 一次执行 → 终态 → 评测结果”的稳定关联键。问题不是少一条日志，而是缺少可比较的实验单位。

## 3. 方案选择与取舍

### 3.1 采用的方案

将 generation 作为最小追踪单位：创建时固化运行版本，执行时写入首响应指标，终止时写入机器错误码，并用快速回归和真实链路 smoke 分别验证静态契约与系统集成。

### 3.2 没有选择的方案

- **只依赖日志搜索**：部署、采样和文案变化会破坏长期可比性，不能作为事实表。
- **先接大型可观测平台**：当前最缺的是稳定字段与语义，不是展示工具；先建平台会把不稳定数据可视化。
- **只保留模型版本**：Agent 行为同样受 Prompt、工具和上下文策略影响，仅记录模型无法归因。
- **立即建立完整 Agent E2E 评分系统**：Phase 0 先提供版本/错误/链路基线；真实 Agent runner、复杂评测集和发布门禁由 EVAL-01/02 渐进建设。

## 4. 最终设计

### 4.1 固化运行版本

`AGENT_RUNTIME_VERSIONS` 定义并随 generation 固化：

- `promptPolicy`
- `toolset`
- `contextPolicy`
- `memoryPolicy`
- `schemaContext`
- `model_provider` 与 `model_name`

版本在任务创建时写入，而不是事后读取当前配置，避免历史 generation 被新配置“改写身份”。

### 4.2 结构化错误码

建立 `GenerationErrorCode`，将机器分类与用户可读文案分离。首批覆盖超时、取消、writer 丢失、容量不足、迭代耗尽、LLM/工具失败、Worker 丢失和未知内部错误。SSE terminal 事件与数据库终态使用同一错误码。

### 4.3 首响应指标

首个有效 LLM delta 到达后写入：

- `generation.first_token_at`
- `generation_attempt.received_first_delta`

指标写入失败只记录 warning，不让观测旁路破坏主生成链路。

### 4.4 两层验证入口

- `pnpm test:generation-baseline`：无外部服务依赖，验证版本格式、错误码唯一性和错误归类。
- `pnpm smoke:agent-baseline`：使用运行中的完整系统，验证版本和首 delta 指标确实经过 API/Worker 链路持久化。

## 5. 重构前后对比

| 维度     | 重构前                   | 重构后                            | 为什么更好                            |
| -------- | ------------------------ | --------------------------------- | ------------------------------------- |
| 行为归因 | 主要靠部署时间和日志猜测 | generation 固化五类策略和模型版本 | 历史回答可精确关联运行配置            |
| 错误统计 | 依赖可变中文文案         | 稳定机器错误码 + 独立用户文案     | 聚合、告警和前端行为不再受措辞影响    |
| 首响应   | 字段存在但证据不足       | generation 与 attempt 双点记录    | 可以区分任务启动、首 delta 与最终完成 |
| 回归判断 | 人工体验或局部 SQL case  | 快速契约回归 + 真实链路 smoke     | 同时覆盖代码契约和系统接线            |

收益的关键不是“多存几个字段”，而是后续每次执行都有了相同的归因坐标。质量层面的前后比较仍需 EVAL-01，不能把链路 smoke 等同于回答质量评测。

## 6. 数据库、兼容与回滚

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

现有 `first_token_at` 开始实际写入。迁移沿用项目的幂等 `init-db`。新增字段为增量数据，不改变既有聊天 API；代码回滚时字段可安全保留，避免破坏历史追踪数据。

## 7. 验证证据

- `pnpm init-db`
- `pnpm typecheck`
- `pnpm test:generation-baseline`
- `pnpm test:reasoning`
- `pnpm --filter @gist/api test:init-db`
- `pnpm benchmark:analytics`：40 个 SQL case、6 个语义 case 通过
- `pnpm build`
- `pnpm smoke:agent-baseline`：2 个 conversation、2 个 generation 均 completed；版本和首 delta 指标通过持久化校验

Vite 存在大于 500 kB chunk 的非阻塞警告，与本阶段目标无关。

## 8. 边界与遗留问题

Phase 0 只建立测量能力，不代表以下问题已经解决：

- 错误码当时仍是基础分类，工具参数和状态转换错误要到 Phase 2 细分。
- smoke 证明链路可运行，不等价于证明回答业务正确。
- 尚未解决同会话并发、假取消、终态后写入等可靠性问题。
- 尚未形成覆盖多轮、注入、失败恢复和图表一致性的完整发布门禁。
- 尚未把 SaaS Growth benchmark 逐 case 送入真实 Agent；`benchmark:analytics` 只验证 fixture、参考 SQL 和语义标准没有漂移。

## 9. 下一阶段为什么是 Phase 1

有了可观测基线后，应先处理可能产生错误数据源和终态后副作用的确定性风险，而不是先调 Prompt。因此 Phase 1 聚焦输入快照、conversation 串行、统一取消和终态写栅栏。
