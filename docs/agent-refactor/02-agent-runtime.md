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

[AnalysisAgent](../../apps/worker/src/analysis/analysis-agent.ts)负责模型循环、工具协议、预算和状态收尾；[Adapter](../../apps/worker/src/analysis/analysis-runtime-adapter.ts)连接权限、快照、工具、上下文及事件。外壳负责队列、租约、心跳、写入权和终态。

Tool 是被模型调用的执行能力；是否封装成类、是否有 AST 检查或重试都不决定它是不是 Agent。当前 SQL 执行器不调用模型，不是独立决策 Agent。SQL 修改由持有业务上下文的主循环决定。

## 输入与出口

Adapter 接收 generation、用户消息、AbortSignal、事件输出、检查写入权和 checkpoint 等回调；身份和数据源来自外壳，不由模型指定。AnalysisRunSnapshot 记录任务、数据源、状态版本、请求消息、时间锚点、定义引用及已加载表。

正文通过自然语言流式展示，`finish_analysis` 独立记录完成状态：

| status | 含义 |
| --- | --- |
| complete | 当前任务已完成，reason=null，missingItems=[] |
| partial | 部分完成，必须说明原因 |
| awaiting_clarification | 等待必要条件 |
| unable_to_complete | 当前无法完成 |

非完整状态必须填写 reason，可用 missingItems 列出缺失项。工具不承载正文。具体类型见 AnalysisOutcome 和 finish-analysis.ts。取消、硬超时和协议失败走 generation 错误通道，不伪装成完成。

## 当前工具

参数摘要不是完整 JSON Schema；工具实现见[analysis-tools.ts](../../apps/worker/src/analysis/analysis-tools.ts)、[SQL 工具](../../apps/worker/src/chat/tools/sql-query.tool.ts)及[图表工具](../../apps/worker/src/chat/tools/generate-chart.tool.ts)。

| 工具 | 关键输入 / 作用 |
| --- | --- |
| get_analysis_state | 读取当前草稿和 revision |
| update_analysis_state | expectedRevision、patch、reason，可选 mode=patch/start_new_task |
| list_schema | 可选 offset、q，分页授权表目录 |
| get_schema | table，可选 offset，读取单表字段页 |
| list_memories | 可选 offset、q，读取本轮固定记忆目录 |
| read_memory | id，读取一个固定版本记忆 |
| propose_memory | content，可选 memoryId / expectedVersion；仅生成候选 |
| execute_sql_query | title、sql、plan（purpose / expectedGrain / expectedShape），绑定已保存状态 |
| list_analysis_evidence | 可选 offset，读取成功历史证据目录 |
| read_query_artifact | queryArtifactId，可选 offset、mode=current/comparison |
| generate_chart | queryArtifactId、chartType、title、xField、yFields；无 filters 参数，改变分析范围必须更新状态并重查 |
| display_query_table | 展示本轮已查询或回读的 Artifact 表格 |
| finish_analysis | 独立记录状态并结束，不重复正文 |

状态更新和提交不能与其他工具混在同一批。其他工具按顺序执行并保持 tool_call_id 配对；安全终止或取消后不继续执行后续副作用。查询与证据回读前必须确认本轮状态，即使纯重画图也需要确认。

## 预算和错误

外壳硬超时默认 120 秒；上下文有预算限制，重复无进展工具调用受到阻止。没有固定 SQL 次数配额。

- 可修正 SQL / 参数错误：返回反馈，由主循环调整。
- 同一 SQL 和错误重复两次后阻止再次执行，连续相同工具调用三次报无进展。
- 模型省略收尾：只追加一次固定提醒，随后只提供 finish_analysis；仍未调用则协议失败并保留内容。
- 取消、权限撤销、写入权丢失、硬超时停止后续执行，不启动额外总结模型。

解析器不支持的语法不会直接执行。SQL_VALIDATION_FAILED 可返回位置和改写建议；修改后的 SQL 仍经过相同权限和只读检查。

## SQL 与证据安全

[执行器](../../apps/worker/src/chat/agents/sql-executor.ts)仅允许单条 SELECT，使用 PostgreSQL AST 检查表、字段和危险表达式，并限制结果行数。确定性 LIMIT 改写保留原始及实际执行 SQL。数据库层支持独立查询账号、只读事务、statement_timeout 和取消传递。

结果质量信号覆盖可检测的截断、空结果及粒度等问题，不自动证明 JOIN 正确、采集完整或因果成立。限制返回行数也不等于限制扫描成本。

## 外壳不变量

- generation 固定请求、身份、数据源和水位；版本只用于追踪，运行时只有一个新实现。
- 同会话串行，跨会话按并发限制推进。
- 状态草稿仅在成功 finalize 的事务中提升；失败或取消不污染下一轮。
- 状态、证据、事件和终态写入遵守写入权及条件写保护。
- 路由切换、组件卸载或 SSE 关闭只影响订阅；取消必须来自明确请求或服务端终止条件。
- 切回会话按快照及事件游标恢复，处理去重和顺序，不能重新发起分析或串入另一会话。

这些行为的真实交互验收见[P01～P07](05-delivery-and-validation.md)，不能用架构存在代替验收通过。
