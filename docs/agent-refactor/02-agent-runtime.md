# Agent 循环与执行契约

> 以下接口名、默认预算、错误分类为实施约定；产品边界见已确认决策 D02/D03/D08/D14/D15/D17。

## 1. 模块边界

```text
现有 API / Outbox / 队列 / Worker / generation 生命周期
  -> AgentRuntimeAdapter（输入快照、AbortSignal、受保护写入、事件适配）
    -> AnalysisAgent（唯一的分析决策模型循环）
      -> ContextAssembler + Prompt 模板
      -> 工具：状态 / 业务定义 / Schema / SQL / Artifact / 图表
    <- AgentOutcome
  -> 外壳统一提交消息、分析状态及 generation 终态
```

建议新核心放 `apps/worker/src/analysis/`，不要继续向旧 `chat.service.ts` 堆分支。共享类型放 `packages/contracts`，持久化适配现有数据库；不新增微服务、通用工作流框架或事件总线。

外围可复用：认证、会话、数据源接入与管理、任务调度、SSE 传输、数据库访问。需要适配而非照搬：查询安全、Artifact 存储与图表。直接重写：分析循环、Prompt 组装、会话分析状态及长期知识接入。

## 2. 核心输入输出

```ts
type AgentRunInput = {
  generationId: string;
  conversationId: string;
  userId: number;                    // 来自认证上下文，禁止模型传入
  datasourceId: number | null;       // 进入数据分析前解析为明确 ID
  requestMessageId: string;
  contextUpperBound: string;
  userMessage: string;
  now: string;                      // 固定本轮相对时间锚点
  signal: AbortSignal;
};
type AgentOutcome =
  | { kind: 'answer'; answer: FinalAnswer; stateRevision: number }
  | { kind: 'clarification'; question: string; stateRevision: number }
  | { kind: 'partial'; answer: FinalAnswer; reason: string; stateRevision: number }
  | { kind: 'refusal'; explanation: string; stateRevision: number };
```

`FinalAnswer` 见证据文档。模型不能生成权限上下文、真实 Artifact ID 或自行决定 generation 终态。失败、取消、超时走外壳错误通道，不能假装 completed。

业务结果和执行状态分开：answer/clarification/partial/refusal 可对应成功提交的 generation；clarification 表示等待下一条用户消息，不保持一个后台任务无限等待。

## 3. 循环和决策出口

每轮：检查取消与写入权 → 组装上下文 → 调用模型 → 校验结构 → 执行合法工具或提交结果 → 记录观察 → 下一轮。

| 情况 | Agent 应做什么 | 代码保障什么 |
| --- | --- | --- |
| 问候或能力询问 | 直接回答 | 不要求强制查库 |
| 缺少关键口径/时间信息 | 提出一个聚焦问题并结束本轮 | 不启动等待式循环；保存已知条件 |
| 信息充分但缺证据 | 获取 Schema 或查询 | 权限、结构校验、预算 |
| SQL 可修正错误 | 据错误和 Schema 修改后重试 | 无隐藏模型调用，尝试计入预算 |
| 空结果/截断/质量疑点 | 核对条件、聚合或解释限制 | 不把空结果等同于零，保留质量元数据 |
| 有候选解释 | 发起能区分解释的验证查询 | 保存验证目的与证据引用 |
| 已有足够证据 | 提交带引用的结果 | 引用存在、可访问、适用性元数据可检查 |
| 预算不够继续 | 提交部分结论与未决问题 | 禁止继续查询，保留有界收尾机会 |
| 越权/危险请求 | 拒绝或说明无法完成 | 不能用 Prompt 覆盖权限 |
| 取消/硬超时/失去写入权 | 立即退出 | 停止 LLM/SQL/写入；不得再启动总结模型 |

不建立“渠道分析完成后必须分析平台”的固定业务状态机。代码使用 running/finalizing/stopped 等生命周期和工具前置条件即可。主要解释需要针对性验证是语义规则；存在一次额外查询不能被当作“解释已验证”的充分证明。

## 4. 工具集合

工具结果统一为成功值或 `{ code, message, retryable, suggestedAction }` 错误。内部异常、连接凭据和堆栈不交给模型。工具 runtime schema 拒绝未知字段、非法类型和越权引用。

| 工具 | 最小输入 | 结果与限制 |
| --- | --- | --- |
| `update_analysis_state` | expectedRevision、允许字段 patch、简短变更说明 | 返回新 revision；事实字段不可由模型写入 |
| `get_schema` | mode: catalog/detail；catalog 可带 cursor/nameFilter，detail 带 tableIds 与可选字段游标 | 返回分页目录或带版本字段详情；逐表校验权限 |
| `read_business_definitions` | mode: catalog/detail；catalog 可带 cursor/nameFilter，detail 带 definitionIds | 返回分页有效目录或本轮已确认版本；初始索引由上下文提供 |
| `propose_business_definition` | 类型、名称、结构化内容、来源消息引用；可选目标 ID/version | 只产生待确认候选；不能直接修改已确认定义 |
| `execute_sql_query` | title、sql、purpose、expectedGrain、expectedShape、可选 hypothesisId | 绑定当前已保存分析状态，返回 Artifact 与质量摘要 |
| `read_query_artifact` | artifactId、可选分页游标 | 返回列、受限行、总量/截断及适用性信息；不执行新 SQL |
| `generate_chart` | artifactId、图表类型、字段映射 | 从结果生成图表，不接受模型复制的数值数组 |
| `submit_analysis` | answer/clarification/partial/refusal 结构化载荷 | 校验后结束；此工具是退出协议，不调用另一个模型 |

SQL 查询所需条件必须先在分析状态中落定；工具的 purpose 等语义字段不替代实际 SQL 校验。代码无法一般性证明 SQL 完全遵守自然语言口径，因此实际 executedSql 与状态快照一并保存，并通过参考结果验证。

首期工具串行执行，避免状态更新和 SQL 在同一批中竞争。若供应商仍返回多个调用，保持 tool_call_id 配对，按顺序逐个校验；任一调用触发取消/安全终止后不执行后续调用。禁止提交结果与其他副作用混在同一批，返回协议错误让模型在预算内修正。

普通自然语言流用于简短行动说明，最终内容由 `submit_analysis` 的结构化载荷统一渲染，避免流式文本和正式答案两份矛盾事实。问候也可使用无数据结论的 answer；模型空输出且无工具调用属于模型协议错误，不记为成功。

## 5. 预算与停止

初始默认值：每 generation 最多 12 次模型调用（含一次收尾）、8 次 SQL 尝试、24 次普通工具调用、120 秒硬超时。数值是起点，用案例调整，不是性能承诺。

- 所有失败尝试计数；状态、Schema 和证据读取也消耗工具预算，防止无 SQL 的空转。
- 相同规范化 SQL＋错误码连续出现 2 次，禁止原样重复；允许改写、补充 Schema 或部分收尾，不继续机械重试。
- 在到达模型上限前预留一次收尾调用；普通工具/SQL 预算耗尽后，仅暴露 `submit_analysis`，要求 partial，已有证据不足则明确“尚无可靠结论”。
- 收尾使用剩余硬超时，不能突破总预算；时间不足或模型仍无法生成合法答案时，由代码输出确定性停止说明并标记 failed，不伪装完整分析。
- 用户取消、权限撤销、写入权丢失、硬超时立即终止，不进行模型收尾。已提交历史证据可查看，本轮未完成内容明确标记未完成。

## 6. SQL、安全与错误

保留单条只读 SELECT、AST fail-closed、授权表字段、独立只读连接、statement timeout、取消传递、行数及结果大小上限。LIMIT 注入等确定性改写记录 originalSql/executedSql；不由模型偷偷修复。

语法/字段错误返回结构化反馈，让主循环选择修正或补充 Schema。权限拒绝和危险操作不得重试绕过，进入拒绝出口；安全解析器不支持的合法语法也不能绕过校验，可说明当前能力限制。SQL 超时仍需检查全局 signal；仅单查询超时且剩余预算足够时可缩小查询。

ResultQuality 只对已知可检测条件出具信号，如截断、空值、重复预期粒度。JOIN 扇出、采集缺口与业务因果不是凭结果形状就能自动证明；需要额外对照查询与评测。blocking 证据不得支持全量总数、全局排名等结论；可以作为观察样本并明确限制。

## 7. 外壳接入不变量

- generation 固定用户消息、数据源、上下文水位和核心版本；同会话串行，不扩大为所有会话全局串行；跨会话执行沿用现有并发限制。
- 外壳注入 `assertWritable`、统一 signal 和事件 sink；核心不直接操作 Redis、心跳、outbox 或 finalize。
- 任一状态保存、Artifact 写入、事件/checkpoint 都遵守写入权和终态边界；检查与写入必须在事务/条件写中防止竞态，不能仅写前检查一次。
- run 内状态先保存为 generation 草稿；成功提交 answer/partial/clarification/refusal 时与消息一起提升为会话当前状态。取消/失败不提升草稿；执行记录保留为未完成且不自动用于下一轮结论。
- 旧核心与新核心短期通过 generation 固定的版本选择，禁止执行途中切换或失败后自动跑一遍旧核心。
- SSE 重连继续使用现有有序事件机制，不要求用户手动刷新；新事件经适配层写入，终态后不得继续发普通内容。
- 任务生命周期独立于前端订阅：路由切换、组件卸载或 SSE 连接关闭只影响订阅，不能触发 generation 取消；取消必须来自明确取消请求或服务端终止条件。
- 切回会话时按现有事件游标/序号机制恢复快照及遗漏事件，处理快照与实时事件交界处的去重和排序；运行中继续流式接收，已完成则恢复完整结果与终态，不重新发起分析。
- 前端按 conversationId/generationId 归属事件和消息；切换后的迟到事件不能写入当前另一个会话。重复订阅或重连不能重复执行 SQL、重复创建 generation 或重复展示内容。
- 保留现有技术栈、传输及任务恢复机制；适配可以调整内部接口，不能削弱上述行为。复杂恢复的新增能力不在本轮范围，已有有效能力不能据此删除。
