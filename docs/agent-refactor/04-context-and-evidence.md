# Prompt、上下文与可追溯证据

## 1. Prompt 的最小组织

使用少量固定模板函数与单一版本常量：身份/分析原则、安全边界、工具协议、验证与停止规则、输出契约。运行时信息作为独立标记的数据区：当前问题、状态、业务定义、Schema、证据索引。

不建设可动态装配的 Prompt 插件平台。Schema 注释、用户定义、数据库单元格和工具数据都是不可信内容；业务上已确认不意味着可以改变系统指令。不要把转义/标签当成安全保证，权限仍由代码执行。

每次模型调用保存轻量 `PromptSnapshot`：promptVersion、核心/工具版本、generation、调用序号、时间锚点、模型标识、状态 revision、定义 id/version、Schema 表/version、Turn ID、Artifact ID、token 估算及省略原因。默认不重复记录敏感原文；引用不存在时不能声称能精确复现当时全部输入。

可解释性限于输入、工具动作、执行边界和证据关联，不记录或展示模型私有推理链。

## 2. Schema 按需读取

1. 首先从授权目录获取表 ID、名称、简短说明；加载目录不授予权限。
2. 小数据源的完整详情能在分配预算内放下时直接提供；默认参考上限 20 表，同时满足 token 预算，不能只看表数量。
3. 其余提供表目录，Agent 调用 `get_schema(tableIds)` 取得字段、类型、已知关联及版本。不能因当前未加载而禁止读取另一张已授权表。
4. 表多时目录分页，提供可确定性的名称过滤/下一页读取；首期无向量排序和隐藏模型筛选。不得静默丢掉目录后让模型以为不存在其他表。
5. 单表详情超预算时分页/按字段范围取回，不静默截断字段定义。Schema 缓存命中仍重新验证权限，缓存键包含数据源与版本。

现有自动 Schema 增强产生的说明仅是未经业务确认的线索，不覆盖业务定义。冲突时主动澄清或要求修订。

## 3. 业务定义发现

当前状态引用的定义优先加载完整版本；其他有效定义先提供 id、名称、类型及短说明目录，按需使用 `read_business_definitions` 获取详情。小目录可全量，超预算分页，不引入语义检索层。

同名、别名碰撞或定义与 Schema 不符，不能随机选择。候选不进入 confirmed 区。每轮重新检查 active 状态和版本，不能依赖上轮摘要。

## 4. 上下文确定性选择

总预算为模型窗口减输出预留、安全余量和实际工具 schema 估算。初始安全余量取窗口的 10%；使用现有保守估算器时注明是估算，不能宣称等于供应商 token 数。

优先顺序：

1. 固定安全/工具/输出规则与本轮用户问题。
2. 当前分析状态、关键定义、正在使用的 Schema。
3. 当前运行中尚未闭合的工具交互和最新观察。
4. 最近完整 Turn，按从近到远选择。
5. 历史证据索引和尚未使用的目录信息。

不是所有状态字段、Schema 和行数据无限保留。工具返回采用代码生成的有界结构摘要和 Artifact 引用；需要完整数据时分页读取。真实执行记录完整存储，与模型可见摘要分开。

超预算依次移除较早完整 Turn、未使用目录详情、冗余历史索引；较早已闭合的工具交互可从模型上下文移除，以系统生成的行动/证据索引承接。保留最近有效观察，不拆开 assistant tool_calls 与对应 tool 消息，不留下孤立 tool_call_id。

当前问题、必要规则、最小状态及当前工具链仍不能放下时，返回明确 `CONTEXT_BUDGET_EXCEEDED` 或在仍可安全调用模型的情况下请求缩小问题。不能静默裁掉当前用户要求或强行发超长请求。

每次模型调用都重新检查预算，不能只在 generation 开始时检查。供应商返回 context-length 错误最多按既定降级规则再尝试一次，并计入预算；不能循环删内容直到答案看似成功。

`ContextSelectionReport` 包含 candidateId、类别、priority、estimatedTokens、selected、omittedReason、内容版本/hash。相同输入快照、预算、策略版本应产生相同结果；固定排序和时间锚点，无模型摘要调用。报告用于开发 walkthrough，无需单独建设 dashboard。

## 5. Query Artifact 契约

优先适配现有存储，但新核心需要以下语义；缺少字段则用兼容性新增字段/扩展表补齐，不假定旧记录天然满足。

- 身份：id、owner/access scope、datasourceId、conversationId、generationId、createdAt。
- 执行事实：originalSql、executedSql、columns/types、rows、returnedRowCount、isLimited；totalRowCount 只有实际已知才填写。
- 分析契约：purpose、expectedGrain、expectedShape、analysisTaskId、stateRevision、定义版本引用及当时内容快照、时间/筛选/粒度快照。
- 质量：empty、truncated、null/重复粒度等可检查信号、限制说明；不能将“没有告警”等同于正确。
- 数据时效：queriedAt、schemaVersion；有实际数据版本才记录，不制造数据快照能力。

Artifact ID 由持久化成功后返回。失败查询仅生成执行记录，不生成伪成功结果。读取和前端展开均重新校验当前用户的数据源访问权限，不能只靠知道 ID。

旧 Artifact 缺少口径/状态元数据时可查看，但标为兼容历史证据，不能自动用于新核心多轮推导。

## 6. 结论与证据引用

```ts
type FinalAnswer = {
  summary: string;
  findings: {
    id: string;
    text: string;
    kind: 'observation' | 'supported_explanation' | 'hypothesis';
    evidence: { artifactId: string; role: 'observation' | 'verification' | 'comparison'; comparisonLabel?: string }[];
  }[];
  limitations: string[];
  unresolvedQuestions: string[];
};
```

数据相关 observation / supported_explanation 必须关联成功且可访问的证据；hypothesis 明确待验证，可以无证据，但不能混写成确定结论。主要解释至少有针对性的 verification 证据，单纯重复相同 SQL 不算验证。程序检查结构和引用，案例检查语义充分性，不建立自动因果裁判。

`summary` 不引入 findings 没有的新数字或新解释，这条先由 Prompt 与人工案例检查，首期不建立逐数字解析器。混合条件比较在 findings 文本及展开信息中明确双方口径。S3 对条件不匹配的证据要求先以 comparison 模式回读，最终 role=comparison 且 comparisonLabel 非空，并保留两组状态快照；标签的语义充分性仍需人工案例检查。质量阻断或状态不匹配时，引用校验返回具体错误，Agent 在剩余预算内改写或部分收尾。

图表使用 Artifact 行数据与字段映射生成，校验字段类型，不接受任意数值数组。比率重新聚合优先重新查询，不能简单平均各组比例。

## 7. 前端交付

保留现有聊天入口、SSE、SQL/表格/图表展示基础。新增：

- 关键发现旁的证据入口，展开查询目的、口径版本、时间筛选、执行 SQL、结果表及质量限制。
- partial、awaiting clarification、failed/cancelled 的可区分文案；部分答案不能显示为完整诊断完成。
- 业务定义独立列表/编辑页面，数据源选择、类型筛选、版本冲突反馈、删除确认；不覆盖数据源管理。
- 对话中的待保存定义确认卡片；展示将写入哪个数据源及完整内容。

建议新增 API：GET `/analysis-artifacts/:id` 返回授权元信息；GET `/analysis-artifacts/:id/rows?cursor=...&limit=...` 返回分页数据，最大页大小 100。列掩码沿用源权限；导出与任意二次计算不属于首期。流式事件携带引用和结构化结果，经现有事件适配层渲染；不要在首轮 SSE 一次传输全部历史数据。

前端开发者可查看上下文报告，但普通用户流程不暴露 token 预算、内部状态枚举等实现细节。
