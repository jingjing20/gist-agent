# 07. 分阶段交付路线图

## 1. 排序原则

先修复会产生错误副作用或错误数据源的确定性问题，再建设状态机和证据层，最后优化记忆、Schema 检索和成本。不要先大改 Prompt，否则缺少评测基线，难以判断改动是提升还是回归。

## 2. 阶段总览

| 阶段    | 目标           | 主要事项                                 | 状态                             |
| ------- | -------------- | ---------------------------------------- | -------------------------------- |
| Phase 0 | 建立基线       | 错误码、版本字段、最小回归与链路 smoke   | 已完成                           |
| Phase 1 | 关闭可靠性缺口 | 真取消、输入快照、会话串行、终态栅栏     | 已完成                           |
| Phase 2 | 确定性编排     | 状态机、工具校验、迭代耗尽、推理展示边界 | 核心完成；ORC-04 待收尾          |
| Phase 3 | 证据与上下文   | Turn、Query Artifact、图表引用、动态预算 | 待实施；合同已定义               |
| Phase 4 | 安全与质量     | 只读角色、fail-closed、结果质量检查      | 待实施；SEC-01 可与 Phase 3 并行 |
| Phase 5 | 记忆升级       | 结构化记忆、版本、纠正与管理             | 待实施                           |
| Phase 6 | 规模化优化     | Schema 检索调优、成本/延迟、在线评估     | 待实施                           |

## 3. Phase 0：建立可比较基线

实施状态：已完成版本、错误码、首 delta、确定性基线和真实链路 smoke。SaaS Growth 真实 Agent 逐 case runner 不属于 Phase 0 完成范围，作为 EVAL-01 保留。详情见 [Phase 0 实施记录](./08-phase-0-implementation.md)。

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
- 真实 Agent 质量前后对比仍依赖 EVAL-01，不在本阶段伪装为已完成。

## 4. Phase 1：可靠性止血

实施状态：核心能力已完成，并通过 stale writer、超时、取消、Redis 暂停、SQL 后端取消等自动化故障测试与 smoke。真实 Worker 进程 kill/recovery 自动化场景保留到 EVAL-02。详情见 [Phase 1 实施记录](./09-phase-1-implementation.md)。

### 为什么排在编排之前

错请求、错数据源和终态后继续写入会直接产生错误事实或幽灵副作用，风险高于回答风格和工具效率。Phase 1 先建立不可变输入与副作用边界，为后续状态机提供可靠执行底座。

### 工作包 A：Generation 输入快照

- generation 保存 datasource、request message、上下文水位。
- Worker 不再读取“最后一条用户消息”。
- 读取上下文只包含水位前已完成 generation 的 request/response 对；正式 Turn 模型由 Phase 3 引入。

### 工作包 B：Conversation 串行

- conversation 级唯一 active generation。
- 前端处理 409/429、取消与重试。

### 工作包 C：结构化取消

- 同一 AbortSignal 贯穿 LLM、工具和 SQL。
- 超时先 abort，等待退出后 finalize。
- publish/checkpoint 增加 writer/terminal guard。

### 完成条件

- 并发、超时、取消、stale writer、Redis 暂停和 SQL 取消测试通过。
- 终态后零普通事件、零消息变化、零查询副作用。
- 真实 Worker kill/recovery 作为 EVAL-02 发布门禁补充，不混同于 stale heartbeat 单元/集成测试。

## 5. Phase 2：确定性编排

实施状态：核心能力已完成。状态机、运行时参数校验、迭代耗尽、原始推理隐藏和 `analyze_result` 下线已落地；空 LLM 响应失败语义和完整 Agent Loop mock 集成测试作为 ORC-04 收尾。详情见 [Phase 2 实施记录](./10-phase-2-implementation.md)。

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
- ORC-04 完成后，空响应不得 completed，且所有 Agent Loop 出口由 mock LLM 集成测试覆盖。

## 6. Phase 3：证据与上下文

实施依据：[Phase 3 实施合同](./11-phase-3-implementation-contract.md)。进入编码前必须先通过其中的 Gate 0；Phase 3 不得绕过 ORC-04。

### 为什么是下一步

Phase 2 已保证动作顺序合法，但图表值仍由模型转录，历史压缩也会丢掉原始查询证据。Artifact 让结论和图表引用同一事实源，Turn 则避免消息级裁剪破坏问答完整性。

### 工作包 A：Artifact 双写

- 新增 Query/Chart Artifact。
- 现有 blocks 与 artifact 暂时双写，保证兼容。

### 工作包 B：Turn 上下文

- 引入完整 Turn。
- PromptBuilder 使用已完成 Turn 和 artifact 摘要。
- 支持通过 artifact ID 继续分析。

### 工作包 C：动态预算

- model capability registry。
- 实际 tokenizer 与工具 schema 计费。
- 按整 Turn 降级。

### 完成条件

- 回答、表格、图表证据一致。
- 典型多轮追问无需重复猜测或复制历史数据。
- Query/Chart Artifact 的权限、保留、双写一致性和回滚测试通过。

## 7. Phase 4：安全与分析质量

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
- 旧 semantic_state 的迁移或只读兼容。

### 完成条件

- 并发更新不丢失。
- 任何记忆都可追溯、可纠正、可删除。
- 非用户确认的数据事实不会进入长期记忆。

## 9. Phase 6：规模化优化

### 为什么最后做

Schema 检索、模型路由和成本优化会扩大策略空间；如果证据、安全和评测尚未稳定，优化很容易以牺牲正确性为代价。Phase 6 必须在前面质量门槛可测之后推进。

### 交付物

- 表目录 + 字段详情两阶段 Schema 检索。
- 生产质量与成本 dashboard。
- 按评测数据调优模型路由、Prompt 和重试策略。
- Artifact/事件/记忆的数据保留与清理策略。

### 完成条件

- 100 张表规模下 Schema 召回质量、token 成本和延迟达到预先定义阈值。
- EVAL-01/02 输出机器可读报告并成为行为改造的 CI/发布门禁。
- 生产 dashboard 能按运行版本追踪质量、错误、成本和延迟。
- Artifact、事件和记忆具备可执行的保留、删除与审计策略。

## 10. 推荐拆分的工程任务

| ID        | 任务                                            | 依赖                          | 状态   | 规模 |
| --------- | ----------------------------------------------- | ----------------------------- | ------ | ---- |
| REL-01    | generation 固化 datasource/request/context 水位 | DB migration                  | 已完成 | M    |
| REL-02    | conversation active generation 唯一约束         | REL-01                        | 已完成 | S    |
| REL-03    | 统一 cancellation context 与终态写栅栏          | 无                            | 已完成 | M    |
| REL-04    | PostgreSQL 真取消和 statement timeout           | REL-03                        | 已完成 | M    |
| ORC-01    | 迭代耗尽错误与核心 outcome                      | 无                            | 已完成 | S    |
| ORC-02    | Tool runtime schema 校验                        | 无                            | 已完成 | M    |
| ORC-03    | 轻量显式状态机                                  | ORC-01/02                     | 已完成 | M    |
| ORC-04    | 空响应失败语义与完整 Agent Loop mock 测试       | ORC-01/03                     | 待完成 | S    |
| PLAN-01   | 最小 QueryPlan 契约                             | ORC-04                        | 待实施 | S    |
| ART-01    | Query Artifact 表与双写                         | ORC-04、PLAN-01、DB migration | 待实施 | M    |
| ART-02    | Chart Artifact 引用查询证据                     | ART-01                        | 待实施 | M    |
| CTX-01    | Turn 模型与整轮上下文                           | REL-01、ART-01                | 待实施 | L    |
| CTX-02    | Model capability/tokenizer                      | CTX-01                        | 待实施 | M    |
| SCHEMA-01 | Schema 目录/详情按需加载接口                    | CTX-02                        | 待实施 | S    |
| SCHEMA-02 | Schema 召回、缓存与规模化调优                   | SCHEMA-01、EVAL-01            | 待实施 | M    |
| SEC-01    | SQL fail-closed、只读角色、动态内容隔离         | REL-04                        | 待实施 | M    |
| SEC-02    | 字段级敏感数据与输出策略                        | SEC-01                        | 待实施 | M    |
| DQ-01     | ResultQuality 检查                              | ART-01、PLAN-01               | 待实施 | M    |
| MEM-01    | MemoryRecord 与 patch 协议                      | ART-01、CTX-01、SEC-01        | 待实施 | L    |
| EVAL-01   | Agent E2E benchmark runner                      | ORC-04、ART-01                | 待实施 | M    |
| EVAL-02   | 并发/注入/多轮/真实 kill 评测集                 | EVAL-01、SEC-01               | 待实施 | M    |

## 11. 每个改造 PR 的 Definition of Done

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
