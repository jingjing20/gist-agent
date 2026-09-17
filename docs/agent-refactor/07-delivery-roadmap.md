# 07. 分阶段交付路线图

## 1. 排序原则

先修复会产生错误副作用或错误数据源的确定性问题，再建设状态机和证据层，最后优化记忆、Schema 检索和成本。不要先大改 Prompt，否则缺少评测基线，难以判断改动是提升还是回归。

## 2. 阶段总览

| 阶段    | 目标           | 主要事项                                 | 建议优先级 |
| ------- | -------------- | ---------------------------------------- | ---------- |
| Phase 0 | 建立基线       | 错误码、版本字段、关键回归测试           | P0         |
| Phase 1 | 关闭可靠性缺口 | 真取消、输入快照、会话串行、终态栅栏     | P0         |
| Phase 2 | 确定性编排     | 状态机、工具校验、明确终态               | P0/P1      |
| Phase 3 | 证据与上下文   | Turn、Query Artifact、图表引用、动态预算 | P1         |
| Phase 4 | 安全与质量     | 只读角色、fail-closed、结果质量检查      | P1         |
| Phase 5 | 记忆升级       | 结构化记忆、版本、纠正与管理             | P1/P2      |
| Phase 6 | 规模化优化     | Schema 检索、成本/延迟调优、在线评估     | P2         |

## 3. Phase 0：建立可比较基线

实施状态：已完成，并在运行中的 API/Worker/Redis/PostgreSQL 环境通过完整 smoke。详情见 [Phase 0 实施记录](./08-phase-0-implementation.md)。

### 交付物

- Prompt/tool/context/memory 版本字段。
- generation 结构化错误码。
- 当前核心链路的集成测试基线。
- 将现有 benchmark 接入一次真实 Agent 执行的最小 runner。

### 完成条件

- 后续每个改造 PR 都能给出前后评测对比。
- 不再只凭人工体验判断 Prompt 效果。

## 4. Phase 1：可靠性止血

实施状态：已完成，并在运行中的 API/Worker/Redis/PostgreSQL 环境通过完整故障注入与 smoke。详情见 [Phase 1 实施记录](./09-phase-1-implementation.md)。

### 工作包 A：Generation 输入快照

- generation 保存 datasource、request message、上下文水位。
- Worker 不再读取“最后一条用户消息”。
- 读取上下文只包含水位前已完成 Turn。

### 工作包 B：Conversation 串行

- conversation 级唯一 active generation。
- 前端处理 409/429、取消与重试。

### 工作包 C：结构化取消

- 同一 AbortSignal 贯穿 LLM、工具和 SQL。
- 超时先 abort，等待退出后 finalize。
- publish/checkpoint 增加 writer/terminal guard。

### 完成条件

- 并发、超时、取消、Worker kill 故障测试全部通过。
- 终态后零普通事件、零消息变化、零查询副作用。

## 5. Phase 2：确定性编排

实施状态：已完成。状态机、运行时参数校验、明确退出结果、原始推理隐藏和 `analyze_result` 下线均已落地；详情见 [Phase 2 实施记录](./10-phase-2-implementation.md)。

### 交付物

- 明确 Agent state 与状态转换表。
- Tool 参数运行时校验。
- 非法工具顺序拒绝。
- iteration exhausted 明确失败。
- 移除 raw reasoning 的产品展示。
- `analyze_result` 下线或降级为结构化决策。

### 完成条件

- 工作流不变量可通过单元测试证明，而不是依赖 Prompt 文本。
- 所有 Agent 退出路径都有明确 outcome。

## 6. Phase 3：证据与上下文

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

## 7. Phase 4：安全与分析质量

### 交付物

- 数据查询只读数据库角色和连接池。
- AST/table validation fail closed。
- statement timeout 与查询取消。
- ResultQuality 自动检查。
- Prompt Injection、JOIN 扇出、截断与时区测试集。

### 完成条件

- 即使应用 SQL 校验出现缺陷，数据库权限仍能阻止写入。
- 截断样本不会被当作全集结论。
- 安全测试必须全通过才能发布。

## 8. Phase 5：结构化记忆

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

### 交付物

- 表目录 + 字段详情两阶段 Schema 检索。
- 生产质量与成本 dashboard。
- 按评测数据调优模型路由、Prompt 和重试策略。
- Artifact/事件/记忆的数据保留与清理策略。

## 10. 推荐拆分的工程任务

| ID      | 任务                                            | 依赖           | 规模 |
| ------- | ----------------------------------------------- | -------------- | ---- |
| REL-01  | generation 固化 datasource/request/context 水位 | DB migration   | M    |
| REL-02  | conversation active generation 唯一约束         | REL-01         | S    |
| REL-03  | 统一 cancellation context 与终态写栅栏          | 无             | M    |
| REL-04  | PostgreSQL 真取消和 statement timeout           | REL-03         | M    |
| ORC-01  | Agent outcome 与迭代耗尽处理                    | 无             | S    |
| ORC-02  | Tool runtime schema 校验                        | 无             | M    |
| ORC-03  | 显式状态机                                      | ORC-01/02      | L    |
| ART-01  | Query Artifact 表与双写                         | DB migration   | M    |
| ART-02  | Chart Artifact 引用查询证据                     | ART-01         | M    |
| CTX-01  | Turn 模型与整轮上下文                           | REL-01、ART-01 | L    |
| CTX-02  | Model capability/tokenizer                      | 无             | M    |
| SEC-01  | SQL fail-closed 与只读角色                      | 无             | M    |
| DQ-01   | ResultQuality 检查                              | ART-01         | M    |
| MEM-01  | MemoryRecord 与 patch 协议                      | DB migration   | L    |
| EVAL-01 | Agent E2E benchmark runner                      | Phase 0        | M    |
| EVAL-02 | 并发/注入/多轮评测集                            | EVAL-01        | M    |

## 11. 每个改造 PR 的 Definition of Done

- 有迁移/兼容/回滚说明。
- 有最小相关单元或集成测试。
- 不破坏 generation 幂等和 SSE 重连。
- 更新 Prompt/tool/context 版本（如适用）。
- 提供基线评测前后对比（如影响 Agent 行为）。
- 新事件和错误使用稳定机器码，不依赖中文字符串判断。
- 日志不泄露完整敏感数据。
- 文档中的实现状态同步更新。

## 12. 暂不建议优先做的事项

- 在缺少评测前反复微调 System Prompt 文案。
- 引入大型通用 Agent 框架来替代全部现有编排。
- 把更多查询结论自动写入长期记忆。
- 为追求并发而允许同一线性 conversation 同时生成多条分支。
- 先做复杂向量 RAG，而不解决 Turn、Artifact 和 Schema 目录建模。
