# 07. 分阶段交付路线图

## 1. 排序原则

本文件记录 Phase 0～6 的历史工程化路线。2026-09-18 复盘后，项目不再以生产平台完备性作为主目标；当前路线见 [学习主线重构路线图](./16-learning-focused-roadmap.md)。

## 2. 阶段总览

| 阶段    | 目标           | 主要事项                                 | 状态   |
| ------- | -------------- | ---------------------------------------- | ------ |
| Phase 0 | 建立基线       | 错误码、版本字段、最小回归与链路 smoke   | 已完成 |
| Phase 1 | 关闭可靠性缺口 | 真取消、输入快照、会话串行、终态栅栏     | 已完成 |
| Phase 2 | 确定性编排     | 状态机、工具校验、迭代耗尽、推理展示边界 | 已完成 |
| Phase 3 | 证据与上下文   | Turn、Query Artifact、图表引用、动态预算 | 已完成 |
| Phase 4 | 安全与质量     | 只读角色、fail-closed、结果质量检查      | 已完成 |
| Phase 5 | 记忆升级       | 结构化记忆、版本、纠正与管理             | 已完成 |
| Phase 6 | 规模化探索     | Schema 检索、成本/延迟、评测与治理       | checkpoint；待按学习价值裁剪 |

## 3. Phase 0：建立可比较基线

实施状态：已完成版本、错误码、首 delta、确定性基线和真实链路 smoke。SaaS Growth 真实 Agent 逐 case runner 不属于 Phase 0 完成范围，由 Phase 6 的完整评测体系承接。详情见 [Phase 0 实施记录](./08-phase-0-implementation.md)。

### 为什么先做

如果没有运行版本、稳定错误码和回归入口，后续结果变化无法归因，也无法区分真实提升与模型随机波动。Phase 0 的收益是让之后每项优化都可比较，而不是直接提升回答质量。

### 交付物

- Prompt/tool/context/memory 版本字段。
- generation 结构化错误码。
- 当前核心链路的集成测试基线。
- 真实 API/Worker 链路 smoke，验证版本、终态与首 delta 持久化。

### 完成条件

- 后续改造能关联到明确运行版本和稳定错误码。
- 行为改造至少有确定性回归与链路 smoke，不再只凭人工体验判断。
- 真实 Agent 质量前后对比仍依赖 Phase 6 的完整评测体系，不在本阶段伪装为已完成。

## 4. Phase 1：可靠性止血

实施状态：核心能力已完成，并通过 stale writer、超时、取消、Redis 暂停、SQL 后端取消等自动化故障测试与 smoke。真实 Worker 进程 kill/recovery 自动化场景保留到 Phase 6 的完整端到端评测。详情见 [Phase 1 实施记录](./09-phase-1-implementation.md)。

### 为什么排在编排之前

错请求、错数据源和终态后继续写入会直接产生错误事实或幽灵副作用，风险高于回答风格和工具效率。Phase 1 先建立不可变输入与副作用边界，为后续状态机提供可靠执行底座。

### 实施内容：Generation 输入快照

- generation 保存 datasource、request message、上下文水位。
- Worker 不再读取“最后一条用户消息”。
- 读取上下文只包含水位前已完成 generation 的 request/response 对；正式 Turn 模型由 Phase 3 引入。

### 实施内容：Conversation 串行

- conversation 级唯一 active generation。
- 前端处理 409/429、取消与重试。

### 实施内容：结构化取消

- 同一 AbortSignal 贯穿 LLM、工具和 SQL。
- 超时先 abort，等待退出后 finalize。
- publish/checkpoint 增加 writer/terminal guard。

### 完成条件

- 并发、超时、取消、stale writer、Redis 暂停和 SQL 取消测试通过。
- 终态后零普通事件、零消息变化、零查询副作用。
- 真实 Worker kill/recovery 在 Phase 6 补充为发布测试，不混同于 stale heartbeat 单元/集成测试。

## 5. Phase 2：确定性编排

实施状态：已完成。状态机、运行时参数校验、迭代耗尽、原始推理隐藏和 `analyze_result` 下线已落地；空 LLM 响应失败语义、依赖失败归一化和完整 Agent Loop mock 集成测试也已补齐。详情见 [Phase 2 实施记录](./10-phase-2-implementation.md)。

### 为什么这样会更好

Prompt 只能提高模型遵守规则的概率，不能证明工具顺序、参数和终态合法。把这些约束放进编排器后，不同模型和异常输出共享同一安全底线，工作流不变量也能通过确定性测试证明。

### 交付物

- 明确 Agent state 与状态转换表。
- Tool 参数运行时校验。
- 非法工具顺序拒绝。
- iteration exhausted 明确失败。
- 移除 raw reasoning 的产品展示。
- `analyze_result` 下线或降级为结构化决策。

### 完成条件

- 工作流不变量可通过单元测试证明，而不是依赖 Prompt 文本。
- 迭代耗尽、非法参数与非法状态具有明确错误码。
- 空响应不得 completed，且所有 Agent Loop 出口由 mock LLM 集成测试覆盖。

## 6. Phase 3：证据与上下文

实施状态：已完成。设计边界见 [Phase 3 实施合同](./11-phase-3-implementation-contract.md)，实际交付与测试证据见 [Phase 3 实施记录](./12-phase-3-implementation.md)。

### 为什么当时排在 Phase 2 之后

Phase 2 已保证动作顺序合法，但图表值仍由模型转录，历史压缩也会丢掉原始查询证据。Artifact 让结论和图表引用同一事实源，Turn 则避免消息级裁剪破坏问答完整性。

### 实施内容：Artifact 双写

- 新增 Query/Chart Artifact。
- 现有 blocks 与 artifact 暂时双写，保证兼容。

### 实施内容：Turn 上下文

- 引入完整 Turn。
- PromptBuilder 使用已完成 Turn 和 artifact 摘要。
- 支持通过 artifact ID 继续分析。

### 实施内容：动态预算

- model capability registry。
- 按实际工具 schema 估算 token，不再使用固定工具预留。
- 按整 Turn 降级。

### 完成条件

- 回答、表格、图表证据一致。
- 典型多轮追问无需重复猜测或复制历史数据。
- Query/Chart Artifact 的权限、保留、双写一致性和回滚测试通过。

## 7. Phase 4：安全与分析质量

实施状态：已完成。独立查询池、生产配置 fail-closed、SQL/表/字段校验、字段策略、ResultQuality 与注入回归均已落地。详情见 [Phase 4 实施记录](./13-phase-4-implementation.md)。

### 为什么不能只靠应用校验

应用规则可能存在遗漏或解析失败；数据库最小权限才是最终写保护。同时，“SQL 能执行”不等于“结果适合下结论”，因此需要截断、空值、JOIN 扇出和时区等结果质量检查。

### 交付物

- 数据查询只读数据库角色和连接池。
- AST/table validation fail closed。
- 保持并回归 Phase 1 已实现的 statement timeout 与查询取消。
- ResultQuality 自动检查。
- Prompt Injection、JOIN 扇出、截断与时区测试集。
- datasource/schema/table/column 敏感字段与授权策略。

### 完成条件

- 即使应用 SQL 校验出现缺陷，数据库权限仍能阻止写入。
- 截断样本不会被当作全集结论。
- 安全测试必须全通过才能发布。

## 8. Phase 5：结构化记忆

### 为什么不能继续扩展 `semantic_state`

无来源、版本和冲突语义的自由 JSON 会把误解长期化，也无法可靠撤销或合并并发更新。结构化记录把记忆从隐式 Prompt 内容变成可治理的数据。

### 交付物

- memory_record 表和 patch 协议。
- 来源、版本、作用域、冲突、撤销、过期。
- 用户查看/纠正/遗忘入口。
- 未上线环境直接移除旧 semantic_state，以 MemoryRecord 为唯一记忆源。

### 完成条件

- 并发更新不丢失。
- 任何记忆都可追溯、可纠正、可删除。
- 非用户确认的数据事实不会进入长期记忆。

## 9. Phase 6：规模化探索 checkpoint

> 本阶段代码已作为 checkpoint 保存。两阶段 Schema 检索与轻量评测直接服务上下文学习，继续保留；dashboard、告警、精细成本、自动保留清理和进程级发布工程移入 Optional，不再作为核心路线完成条件。

### 为什么最后做

Schema 检索、模型路由和成本优化会扩大策略空间；如果证据、安全和评测尚未稳定，优化很容易以牺牲正确性为代价。Phase 6 必须在前面质量门槛可测之后推进。

### 交付物

- 表目录 + 字段详情两阶段 Schema 检索。
- 生产质量与成本 dashboard。
- 按评测数据调优模型路由、Prompt 和重试策略。
- Artifact/事件/记忆的数据保留与清理策略。

### 完成条件

- 100 张表规模下 Schema 召回质量、token 成本和延迟达到预先定义阈值。
- 完整 Agent 评测输出机器可读报告，并成为行为改造的 CI/发布门槛。
- 生产 dashboard 能按运行版本追踪质量、错误、成本和延迟。
- Artifact、事件和记忆具备可执行的保留、删除与审计策略。

## 10. 当前推进位置

Phase 0～4 已完成。Phase 4 已按以下顺序交付，且每一步都有对应的自动化回归：

1. Agent 查询使用独立连接池和最小权限数据库角色；生产环境缺少独立凭据时拒绝启动。
2. SQL 仅接受单条 SELECT，解析、表、schema、函数或字段范围不确定时 fail closed。
3. 引入字段 allow/mask/deny 策略，并在 Schema 暴露、查询校验和结果输出三处执行。
4. Query Artifact 持久化 ResultQuality，阻断截断、重复粒度等不可靠结论。
5. Schema、记忆和查询值标记为 untrusted data，并加入攻击回归。
6. 真实 PostgreSQL 验证只读角色不可写、不可读取未授权表且 statement timeout 生效。

Phase 5 已完成结构化、可追溯、可纠正和可删除的长期记忆。Phase 6 已形成可回溯的生产化探索 checkpoint，但尚未执行真实模型全量验收，且部分能力与学习目标不匹配。当前转入 L1：Agent Loop 与 Prompt 可解释化，见 [学习主线重构路线图](./16-learning-focused-roadmap.md)。

## 11. 每个改造 PR 的完成条件

- 有迁移/兼容/回滚说明。
- 有最小相关单元或集成测试。
- 不破坏 generation 幂等和 SSE 重连。
- 更新 Prompt/tool/context 版本（如适用）。
- 提供基线评测前后对比（如影响 Agent 行为）。
- 新事件和错误使用稳定机器码，不依赖中文字符串判断。
- 日志不泄露完整敏感数据。
- 文档中的实现状态同步更新。
- 实施记录解释重构前行为、根因、方案取舍和重构后收益，不只罗列改动文件。
- 明确本 Phase 没有解决什么，以及由哪个后续 Phase 承接，避免把局部完成描述成全链路完成。

## 12. 暂不建议优先做的事项

- 在缺少评测前反复微调 System Prompt 文案。
- 引入大型通用 Agent 框架来替代全部现有编排。
- 把更多查询结论自动写入长期记忆。
- 为追求并发而允许同一线性 conversation 同时生成多条分支。
- 先做复杂向量 RAG，而不解决 Turn、Artifact 和 Schema 目录建模。
