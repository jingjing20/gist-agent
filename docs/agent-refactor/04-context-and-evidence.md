# Prompt、上下文与可追溯证据

当前实现入口：[Adapter](../../apps/worker/src/analysis/analysis-runtime-adapter.ts)、[上下文选择](../../apps/worker/src/analysis/context-assembler.ts)、[证据接口](../../apps/api/src/analysis-artifact/analysis-artifact.module.ts)。本文区分实现机制与仍需语义验收的规则。

## 1. Prompt 的最小组织

使用少量固定模板函数与单一版本常量：身份/分析原则、安全边界、工具协议、验证与停止规则、输出契约。运行时信息作为独立标记的数据区：当前问题、状态、数据源记忆、Schema、证据索引。

不建设可动态装配的 Prompt 插件平台。Schema 注释、用户定义、数据库单元格和工具数据都是不可信内容；业务上已确认不意味着可以改变系统指令。不要把转义/标签当成安全保证，权限仍由代码执行。

每次模型调用保存上下文报告及轻量输入快照：核心/工具/上下文策略版本、generation、调用序号、时间锚点、模型标识、状态 revision、定义引用、Schema 内容 hash、Turn / Artifact 引用、token 估算及省略原因。字段由 Adapter 组装，不是独立的 PromptSnapshot 类型；不保存完整敏感输入原文，不能据此声称可精确复现全部输入。

可解释性限于输入、工具动作、执行边界和证据关联，不记录或展示模型私有推理链。

## 2. Schema 按需读取

1. 首先提供授权表名和展示名；完整目录页还包含有界说明。加载目录不授予权限。
2. 初始上下文提供最多 20 张表的目录及下一页位置，不自动注入所有表的完整字段。
3. Agent 调用 `get_schema({ table, offset })` 读取单表字段，每页最多 20 个，并返回 nextOffset。未加载的授权表仍可读取。
4. 更多目录通过 `list_schema({ offset, q })` 按名称过滤和分页；没有向量排序或隐藏模型筛选。
5. 目录与详情读取均重新检查访问权限。分页不是数据库级流式读取承诺；服务端仍可能读取完整目录或详情后切片。

现有自动 Schema 增强产生的说明仅是未经业务确认的线索，不覆盖数据源记忆。冲突时主动澄清或要求修订。

## 3. 数据源记忆发现

当前状态引用的记忆加载完整版本；初始目录最多 20 条，更多内容由 `list_memories({ offset, q })` 分页发现，使用 `read_memory({ id })` 读取单条记忆。同一 generation 使用固定版本快照，不引入语义检索层。

同名记忆不能随机选择。候选确认前不进入长期记忆。每轮重新检查 active 状态和版本，不能依赖上轮摘要。

## 4. 上下文确定性选择

当前预算为模型窗口减去输出预留及窗口的 10% 安全余量；工具 schema 也占用预算。发生允许的一次 context-length 重试时，再将可用预算缩减为 75%。字符加权估算不等于供应商真实 token 数。

优先顺序：

1. 固定安全/工具/输出规则与本轮用户问题。
2. System Prompt 中的当前状态、已选择定义与观察索引，和当前问题一起构成必需项。
3. 当前轮的完整工具批次，最近工具批次及最后一组消息必须保留。
4. 最近成功 Turn，作为问题与答案文本提供，不能代替原始证据。
5. 表目录、定义目录及历史证据索引。

不是所有状态字段、Schema 和行数据无限保留。工具返回采用代码生成的有界结构摘要和 Artifact 引用；需要完整数据时分页读取。真实执行记录完整存储，与模型可见摘要分开。

选择器先放必需项，再按优先级尝试可选项；当前工具交互优先于历史轮次，历史轮次优先于目录组。放不下的候选整组省略并记录原因，不拆开 assistant tool_calls 与对应 tool 消息。Schema 详情存在工具返回中，不承诺所有已读取字段永久留在上下文。

当前问题、必要规则、最小状态及当前工具链仍不能放下时，返回明确 `CONTEXT_BUDGET_EXCEEDED` 或在仍可安全调用模型的情况下请求缩小问题。不能静默裁掉当前用户要求或强行发超长请求。

每次模型调用都重新检查预算，不能只在 generation 开始时检查。供应商返回 context-length 错误最多按既定降级规则再尝试一次，并计入预算；不能循环删内容直到答案看似成功。

`ContextSelectionReport` 包含 candidateId、类别、priority、estimatedTokens、selected、omittedReason、内容版本/hash。相同输入快照、预算、策略版本应产生相同结果；固定排序和时间锚点，无模型摘要调用。报告用于开发 walkthrough，无需单独建设 dashboard。

## 5. Query Artifact 契约

当前 Artifact 使用统一结构保存以下语义；字段以共享契约与 ArtifactRepository 为准，不提供旧结构兼容。

- 身份：id、owner/access scope、datasourceId、conversationId、generationId、createdAt。
- 执行事实：originalSql、executedSql、columns/types、rows、returnedRowCount、isLimited；totalRowCount 只有实际已知才填写。
- 分析契约：purpose、expectedGrain、expectedShape、analysisTaskId、stateRevision、定义版本引用及当时内容快照、时间/筛选/粒度快照。
- 质量：empty、truncated、null/重复粒度等可检查信号、限制说明；不能将“没有告警”等同于正确。
- 数据时效：queriedAt、schemaVersion；有实际数据版本才记录，不制造数据快照能力。

Artifact ID 由持久化成功后返回。失败查询仅生成执行记录，不生成伪成功结果。读取和前端展开均重新校验当前用户的数据源访问权限，不能只靠知道 ID。

缺少当前分析元数据或权限指纹的证据不能自动用于推导；前端接口会拒绝无效权限快照，不承诺旧 Artifact 可查看。

## 6. 结论与证据引用

```ts
type AnalysisAnswer = {
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

当前聊天入口和数据源记忆页面提供：

- 关键发现旁的证据入口，展开查询目的、口径版本、时间筛选、执行 SQL、结果表及质量限制。
- partial、awaiting clarification、failed/cancelled 的可区分文案；部分答案不能显示为完整诊断完成。
- 数据源记忆独立列表/编辑页面，数据源选择、版本冲突反馈、删除确认；不覆盖数据源管理。
- 对话中的待保存定义确认卡片；展示将写入哪个数据源及完整内容。

已实现 GET `/analysis-artifacts/:id` 和 GET `/analysis-artifacts/:id/rows`，两者均要求 query 参数 conversationId。rows 另支持 cursor（非负行偏移）和 limit（默认 50，最大 100）。每次读取重新验证身份、会话、数据源权限和字段策略指纹。分页从已保存的 JSON 结果切片，不是数据库流式分页。导出与任意二次计算不属于首期。

前端开发者可查看上下文报告，但普通用户流程不暴露 token 预算、内部状态枚举等实现细节。
