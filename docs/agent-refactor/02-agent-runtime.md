# Agent 运行时与执行边界

产品边界见 D02 / D03 / D08 / D14 / D15 / D17。以下描述当前实现；具体类型以[共享契约](../../packages/contracts/src/analysis.ts)和工具代码为准。

## 架构

```text
API → Outbox → BullMQ / Redis → Worker generation 外壳
  → AnalysisRuntimeAdapter
    → AnalysisAgent ↔ 状态 / 定义 / Schema / SQL / Artifact / 图表工具
  → 外壳提交消息、提升分析草稿、写入 generation 终态
API SSE → Web 按会话和 generation 恢复及展示
```

[AnalysisAgent](../../apps/worker/src/analysis/analysis-agent.ts)负责模型循环、工具协议、预算和结构化退出；[Adapter](../../apps/worker/src/analysis/analysis-runtime-adapter.ts)连接权限、快照、工具、上下文及事件。外壳负责队列、租约、心跳、写入权和终态。

Tool 是被模型调用的执行能力；是否封装成类、是否有 AST 检查或重试都不决定它是不是 Agent。当前 SQL 执行器不调用模型，不是独立决策 Agent。SQL 修改由持有业务上下文的主循环决定。

## 输入与出口

Adapter 接收 generation、用户消息、AbortSignal、事件输出、检查写入权和 checkpoint 等回调；身份和数据源来自外壳，不由模型指定。AnalysisRunSnapshot 记录任务、数据源、状态版本、请求消息、时间锚点、定义引用及已加载表。

submit_analysis 有四种出口：

| kind | 内容 |
| --- | --- |
| answer | 完整结构化答案 |
| partial | 已取得的发现、限制和未决问题，可附 reason |
| clarification | 聚焦的澄清问题 |
| refusal | 无法执行的说明 |

具体字段以 AnalysisOutcome 和[提交校验](../../apps/worker/src/analysis/submission.ts)为准。业务出口不同于 generation 执行状态；取消、硬超时和协议失败走错误通道，不能伪装成成功答案。

## 当前工具

参数摘要不是完整 JSON Schema；工具实现见[analysis-tools.ts](../../apps/worker/src/analysis/analysis-tools.ts)、[SQL 工具](../../apps/worker/src/chat/tools/sql-query.tool.ts)及[图表工具](../../apps/worker/src/chat/tools/generate-chart.tool.ts)。

| 工具 | 关键输入 / 作用 |
| --- | --- |
| get_analysis_state | 读取当前草稿和 revision |
| update_analysis_state | expectedRevision、patch、reason，可选 mode=patch/start_new_task |
| list_schema | 可选 offset、q，分页授权表目录 |
| get_schema | table，可选 offset，读取单表字段页 |
| list_business_definitions | 可选 offset、q，读取本轮固定定义目录 |
| read_business_definitions | id，读取一个固定版本定义 |
| propose_business_definition | content，可选 definitionId / expectedVersion；仅生成候选 |
| execute_sql_query | title、sql、plan（purpose / expectedGrain / expectedShape），绑定已保存状态 |
| list_analysis_evidence | 可选 offset，读取成功历史证据目录 |
| read_query_artifact | queryArtifactId，可选 offset、mode=current/comparison |
| generate_chart | queryArtifactId、chartType、title、xField、yFields；新核心禁止借 filters 改变分析范围 |
| submit_analysis | 校验结构化业务结果并退出 |

状态更新和提交不能与其他工具混在同一批。其他工具按顺序执行并保持 tool_call_id 配对；安全终止或取消后不继续执行后续副作用。查询与证据回读前必须确认本轮状态，即使纯重画图也需要确认。

## 预算和错误

默认最多 12 次模型调用、8 次 SQL 尝试、24 次普通工具调用；外壳硬超时默认 120 秒。数值是执行上限，不是性能承诺。失败尝试也计数，模型预算预留一次收尾，普通工具预算耗尽后只允许提交。

- 可修正 SQL / 参数 / 提交错误：返回反馈，主循环在剩余预算内调整。
- 相同 SQL 与错误重复出现：阻止无效原样重试，可改写或部分收尾。
- 预算不足：提交 partial；无法合法提交时明确失败。
- 取消、权限撤销、写入权丢失、硬超时：停止后续执行，不启动额外总结模型。
- 空模型响应和不合法调用：按协议错误处理，不当作分析完成。

解析器不支持的语法不会直接执行。SQL_VALIDATION_FAILED 可返回位置和改写建议；修改后的 SQL 仍经过相同权限和只读检查。

## SQL 与证据安全

[执行器](../../apps/worker/src/chat/agents/sql-executor.ts)仅允许单条 SELECT，使用 PostgreSQL AST 检查表、字段和危险表达式，并限制结果行数。确定性 LIMIT 改写保留原始及实际执行 SQL。数据库层支持独立查询账号、只读事务、statement_timeout 和取消传递。

结果质量信号覆盖可检测的截断、空结果及粒度等问题，不自动证明 JOIN 正确、采集完整或因果成立。限制返回行数也不等于限制扫描成本。

## 外壳不变量

- generation 固定请求、身份、数据源、水位和协议版本；未知版本拒绝执行，无旧核心回退。
- 同会话串行，跨会话按并发限制推进。
- 状态草稿仅在成功 finalize 的事务中提升；失败或取消不污染下一轮。
- 状态、证据、事件和终态写入遵守写入权及条件写保护。
- 路由切换、组件卸载或 SSE 关闭只影响订阅；取消必须来自明确请求或服务端终止条件。
- 切回会话按快照及事件游标恢复，处理去重和顺序，不能重新发起分析或串入另一会话。

这些行为的真实交互验收见[P01～P07](05-delivery-and-validation.md)，不能用架构存在代替验收通过。
