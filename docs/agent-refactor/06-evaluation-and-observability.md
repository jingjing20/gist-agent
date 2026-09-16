# 06. 评测与可观测性改造

## 1. 目标

让每次 Prompt、模型、工具、上下文和记忆策略变更都能量化比较，并能在生产问题发生时定位到具体 generation、阶段和证据。

## 2. 当前实现证据

- `benchmarks/saas-growth/cases.json` 已有 SQL 标准结果和语义题要点。
- `validate-analytics-benchmark.ts` 只执行参考 SQL并验证 fixture/标准答案没有漂移，没有调用真实 Agent。
- reasoning context 只有一份脚本级回归测试。
- LLM 通过 LangSmith wrapper 调用，但应用没有统一记录 prompt policy version、模型版本、工具版本和 context selection。
- generation 表存在 `first_token_at`，generation_attempt 存在 `received_first_delta`，代码中未形成完整指标闭环。
- `generation_event` 表已创建，但当前事件主链使用 Redis Stream，持久审计用途尚未落地。

## 3. 评测分层

### 3.1 单元契约测试

- PromptBuilder：Turn 不拆分、预算降级、Schema/Memory 转义。
- Tool Validator：错误参数、非法状态、缺失 artifact。
- SQL Guard：多语句、跨 schema、CTE、子查询、解析失败、危险函数。
- Memory Patch：幂等、冲突、纠正、删除、并发版本。
- Chart Builder：字段对应和数值一致性。

### 3.2 确定性集成测试

使用 mock LLM 驱动完整状态机：

- 正常直接回答；
- 单次查询；
- 多次查询；
- SQL 报错重规划；
- 澄清问题；
- 取消、超时、Worker 丢失；
- 同 conversation 并发；
- SSE 断线重连和终态去重。

### 3.3 Agent 离线评测

真实调用目标模型，记录模型输出、SQL、artifact 和最终回答。评分维度：

| 维度 | 示例指标 |
| --- | --- |
| 结果正确性 | 与标准结果一致、数值误差、排序一致 |
| 口径正确性 | 分母、过滤、粒度、时间范围 |
| 工具行为 | 合法顺序、无多余查询、重试次数 |
| 证据一致性 | 回答/表格/图表是否来自相同 artifact |
| 安全性 | 越权阻断、注入攻击成功率 |
| 多轮能力 | 指代解析、口径纠正、历史 artifact 复用 |
| 拒答质量 | 无数据、因果不足、外部数据缺失 |
| 性能成本 | 首 token、总耗时、输入/输出 token、工具轮数 |

建议先把现有 SaaS Growth case 转为 Agent E2E case，再新增多轮与攻击用例。

### 3.4 生产在线指标

- generation 成功、失败、取消、超时、迭代耗尽比例；
- queue wait、首 token、LLM、SQL、结果验证、总耗时分位数；
- 每轮 token、成本、工具次数、SQL 修复率；
- 空结果率、截断率、重新规划率、澄清率；
- SSE gap/snapshot 恢复率；
- memory 提取、冲突、拒绝和命中率；
- 用户重问/纠正率，可作为错误信号但不能单独等同满意度。

## 4. 版本与追踪模型

每个 generation 至少记录：

```ts
interface GenerationTraceContext {
  generationId: string;
  modelProvider: string;
  modelName: string;
  promptPolicyVersion: string;
  toolsetVersion: string;
  contextPolicyVersion: string;
  memoryPolicyVersion: string;
  schemaVersion: string;
  datasetVersion?: string;
}
```

所有日志、trace、artifact 和评测结果以 generation ID 关联。敏感数据默认不进入外部追踪平台，必要时只记录 hash、字段名和统计元信息。

## 5. Trace 阶段

建议统一 span：

```text
generation
  context.load
  context.select
  prompt.render
  llm.interpret
  llm.plan
  sql.validate
  sql.execute
  result.validate
  llm.synthesize
  chart.build
  message.commit
  memory.distill
```

每个 span 记录开始/结束、状态、错误码、重试次数和输入输出大小，不默认记录完整敏感内容。

## 6. 评测发布门槛

对 Prompt/模型/工具重大改造建立门禁：

- 核心 SQL case 结果正确率不得下降；
- 安全用例必须 100% 阻断；
- 多轮口径纠正必须通过；
- 图表数值一致性必须 100%；
- P95 延迟和平均成本不得超过预设回归阈值；
- 任何标准答案更新必须人工审核，禁止为了通过测试直接刷新 golden。

模型评测存在随机性，至少固定温度、重复运行，并同时报告均值和最差表现。

## 7. 实施步骤

1. 为 Prompt、工具、上下文、记忆增加版本常量并写入 generation。
2. 完善 generation timing 字段的实际写入。
3. 建立结构化错误码，减少依赖中文错误文本聚合。
4. 扩展 benchmark runner，使其通过 API/Worker 执行真实对话。
5. 增加多轮、注入、并发、失败恢复 case。
6. 输出机器可读 JSON 评测报告，CI 负责比较基线。
7. 再接入生产 dashboard 和告警。

## 8. 涉及文件

- `benchmarks/saas-growth/cases.json`
- `apps/api/scripts/validate-analytics-benchmark.ts`
- `scripts/reasoning-context-regression.mjs`
- `apps/worker/src/chat/chat.service.ts`
- `apps/worker/src/chat/generation.service.ts`
- `apps/worker/src/chat/generation-reliability.service.ts`
- `apps/api/scripts/init-db.ts`
- `packages/llm/src/index.ts`
- `packages/contracts/src/index.ts`

## 9. 验收标准

- CI 能运行不依赖真实模型的状态机集成测试。
- 可选真实模型评测能输出逐 case 证据和汇总分数。
- 任一生产回答都能查到使用的模型、Prompt、工具、上下文和 Schema 版本。
- `first_token_at`、阶段耗时、token 和成本指标真实可用。
- 安全、并发、取消和记忆纠正都有稳定回归用例。

