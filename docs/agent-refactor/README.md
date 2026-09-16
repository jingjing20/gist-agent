# Gist Agent 数据分析链路改造规划

> 状态：Draft
>
> 评审日期：2026-09-16
>
> 适用范围：API、Worker、LLM 编排、Prompt、上下文、记忆、SQL 执行、评测与可观测性

## 1. 文档目的

本目录记录当前数据分析 Agent 的架构复盘与后续改造计划。它不是功能介绍，而是实施依据：每个专题都包含现状证据、问题、目标设计、涉及文件、改造步骤和验收标准。

## 2. 总体判断

当前系统已经具备较好的工程骨架：API/Worker 分离、事务 Outbox、Redis Stream、generation 幂等、心跳与取消、AST SQL 只读校验、分层上下文压缩、业务口径蒸馏。这些能力足以支持 Demo 和内部试用。

阻碍系统进入“可信数据分析”阶段的主要问题不是模型能力，而是以下确定性约束仍不充分：

1. 超时不等于执行真正停止，终态后仍可能发生副作用。
2. 同一会话的并发 generation 没有稳定的上下文快照。
3. 工具依赖与调用顺序由 Prompt 约束，代码未形成状态机。
4. 查询证据没有成为一等 artifact，历史压缩后难以可靠追问。
5. 长期记忆缺少来源、版本、冲突、撤销和并发更新语义。
6. Schema、记忆和数据内容存在持久化 Prompt Injection 风险。
7. 现有 benchmark 验证标准 SQL，不验证真实 Agent 行为。

## 3. 文档导航

| 文档 | 主题 | 核心产出 |
| --- | --- | --- |
| [01-execution-reliability.md](./01-execution-reliability.md) | 执行与并发可靠性 | 真取消、会话隔离、终态栅栏、幂等副作用 |
| [02-orchestration-and-prompts.md](./02-orchestration-and-prompts.md) | 编排与提示词 | 显式状态机、Prompt 分层、工具输入输出契约 |
| [03-context-and-artifacts.md](./03-context-and-artifacts.md) | 上下文与证据 | Turn 模型、查询 artifact、Token 预算与召回 |
| [04-memory.md](./04-memory.md) | 记忆系统 | 分类记忆、版本与来源、冲突和遗忘机制 |
| [05-data-security-and-quality.md](./05-data-security-and-quality.md) | 数据安全与分析质量 | SQL fail-closed、只读账号、注入防护、结果校验 |
| [06-evaluation-and-observability.md](./06-evaluation-and-observability.md) | 评测与可观测性 | Agent E2E 评测、指标体系、版本追踪 |
| [07-delivery-roadmap.md](./07-delivery-roadmap.md) | 分阶段路线图 | 里程碑、依赖关系、Definition of Done |
| [08-phase-0-implementation.md](./08-phase-0-implementation.md) | Phase 0 实施记录 | 版本追踪、错误码、首响应指标与验证结果 |

## 4. 优先级摘要

### P0：先保证不会串话、不会“死后继续执行”

- 超时、取消和 ownership 丢失后，停止 LLM、SQL、事件发布和 checkpoint。
- generation 固化 `request_message_id`、`datasource_id` 和上下文水位。
- 同一 conversation 默认串行；未来若开放并行，必须基于分支/父消息建模。
- Agent 达到最大迭代次数时必须失败或进入明确的受控收尾，不能静默成功。

### P1：建立可信的分析执行模型

- 用状态机代替纯 Prompt 工作流。
- 查询结果保存为 artifact，图表直接消费 artifact。
- 上下文按完整 Turn 组织，不再按单条消息独立裁剪。
- SQL 安全从 AST 单层防线升级为应用校验 + 数据库只读角色 + statement timeout。
- 建立真正执行 Agent 的离线评测。

### P2：提高规模化质量与成本效率

- Schema 分层检索，避免全量 Schema 永久注入。
- 记忆分类、版本化、可纠正、可遗忘。
- Prompt、模型、工具和上下文策略统一版本化。
- 完善质量、成本、延迟和恢复指标。

## 5. 建议目标链路

```text
接收请求
  -> 固化 generation 输入快照
  -> 会话级排队/分支校验
  -> 构建受控上下文
  -> 理解问题与确认口径
  -> 制定查询计划
  -> SQL 校验与执行
  -> 生成 Query Artifact
  -> 结果质量检查
  -> 结论生成
  -> 可选 Chart Artifact
  -> 原子化提交消息与终态
  -> 异步、版本化更新记忆
```

## 6. 决策原则

- Prompt 负责语义判断，代码负责权限、顺序、状态和不变量。
- 模型输出是候选，不是事实；数据结论必须能追溯到查询证据。
- 对话历史用于交流连续性，artifact 用于证据连续性，memory 用于稳定偏好和口径。
- 任何终态都必须是副作用边界；终态之后不得继续写消息、发普通事件或执行查询。
- 安全检查无法证明安全时必须拒绝执行，即 fail closed。
- 先建立评测与版本基线，再进行大规模 Prompt 调优。
