# Agent 工具与共享契约参考

用途：按分析需要选择工具，理解工具输出、共享对象和前端表示各自负责什么；适用读者：Agent、API和前端开发。完整 JSON Schema 由工具 `definition` 维护，不在这里复制第二份。本文是速查入口，完整执行过程读[Agent Loop](../guides/agent-loop.md)、[查询与结果](../guides/sql-and-artifacts.md)。

## 当前注册的13个工具

事实来源：[Adapter.run](../../apps/worker/src/analysis/analysis-runtime-adapter.ts)、[analysisTools](../../apps/worker/src/analysis/analysis-tools.ts)、[FINISH_TOOL](../../apps/worker/src/analysis/finish-analysis.ts)。

| 名称 | 作用与调用时机 | 关键参数 | 结果/约束 | 实现 |
| --- | --- | --- | --- | --- |
| get_analysis_state | 先查当前分析问题、筛选、时间、记忆引用和未决问题，确定接着分析什么；需要更新状态时从这里取得当前版本 | 无 | 当前草稿与 `revision` | analysisTools |
| update_analysis_state | 查询或回读证据前，显式确认本轮分析条件；追问改变条件时修订草稿，完全换题时开启新任务；也用于记录有证据支持的假设 | expectedRevision、patch、reason；可选 mode | 乐观版本校验，须独立调用；`start_new_task` 清空旧任务条件。只记录条件，不代替 SQL 实施筛选 | patchAnalysisState + states.save |
| list_schema | 不知道可用表名，或首批目录不足时，发现当前源内有权限访问的表；它回答“可以查哪些表” | 可选 q/offset | 授权表目录，每页 20、nextOffset；不返回字段或业务数据 | Worker SchemaService |
| get_schema | 写 SQL 前核对目标表的真实字段名、类型、注释；字段跨页时补读需要的页，避免猜列名 | table；可选 offset | 每页 20 字段、nextOffset，记录完整 detail hash；加载表不改变权限 | Worker getSchemaDetail |
| list_memories | 寻找本问题相关的已确认指标口径或业务约定；目录描述被截断时继续读完整正文 | 可选 q/offset | 本轮固定 active 版本目录，每页 20；候选不参与召回 | session.memories |
| read_memory | 读取选中知识的完整定义，确定是否纳入 `update_analysis_state.memoryRefs`，让查询和结果记录采用的知识版本 | id | 完整固定版本正文；不自动选中引用，也不读取管理页刚改的新版本 | session.memories |
| list_analysis_evidence | 追问或比较分析时发现当前会话、数据源已有的成功历史查询，判断是否值得回读而非立即重新查询 | 可选 offset | 历史证据索引，每页 20；目录不是行数据，必须回读后才可引用 | ArtifactRepository.listAnalysisEvidence |
| read_query_artifact | 不再次访问业务表，读取已经持久化的查询数据、执行时间和查询时条件；默认为本轮复用，明确比较旧条件时选择 comparison | queryArtifactId；可选 offset/mode | prepared 后每页 20 行、页内行 JSON 最多 16,000 字符；检查权限、任务、条件、新鲜度；历史回读不刷新数据库 | Adapter readEvidence + evidenceMismatch |
| execute_sql_query | 需要新数据或旧证据不适用时，执行模型给出的 SELECT，取得真实结果并建立可追溯证据；该工具执行 SQL，不负责调用另一个模型生成 SQL | title/sql/plan | 一次只读执行、持久 Query Artifact、质量结果；当前 Adapter 要求先确认状态。用于分析的查询不会自动展示表格 | [SqlQueryTool](../../apps/worker/src/chat/tools/sql-query.tool.ts) |
| display_query_table | 用户要明细、排名或精确核对时，把本轮已查询或回读的证据交给前端表格组件展示；无需再次执行 SQL | queryArtifactId；可选 title | 本轮 observed、条件匹配，发送 `display=true`；受限数据可展示为样例，不能宣称完整总体 | Adapter 内包装 |
| generate_chart | 用已取得的查询结果做趋势、类别比较或其他可视化；模型选择图形和字段映射，程序从证据行构造数值数组 | queryArtifactId/chartType/title/xField/yFields；可选 sort | 必须先观察证据，再另批调用；支持 6 类图表，检查条件、字段类型和阻断性质量问题 | [GenerateChartTool](../../apps/worker/src/chat/tools/generate-chart.tool.ts) |
| propose_memory | 用户对话出现可复用的长期定义时，提交待审核的新知识或目标知识的修改候选，供成功任务后人工确认 | content；可选 memoryId/expectedVersion | 只写候选，不直接更新正式知识；要求数据源所有者和活动 writer。查询结果和未验证推断不应作为定义 | [ProposeMemoryTool](../../apps/worker/src/analysis/propose-memory-tool.ts) |
| finish_analysis | 正文与需要的展示已完成后，声明本轮业务交付程度；无法完成或待澄清时同时记录原因和真正缺失的信息 | status/reason/missingItems | 须独立调用，不承载正文；成功后 Loop 结束。`complete` 要求 reason=null、missingItems=[] | AnalysisAgent + validateFinish |

分页参数 offset 为非负整数，analysisTools 上限 100000；只在 nextOffset 非空且确实还需要数据时继续分页。工具的调用次序不是固定工作流，由 LLM 在协议与权限约束内选择。例如需要“按天统计”的新数据，通常先核对 Schema 和口径，再独立确认状态，查询成功收到 Artifact ID 后才决定是否另批展示或绘图。读目录、读正文、选中引用、执行查询、交付结果分别承担不同作用。

所有工具执行前后受 signal 和 writer 边界限制；能注册工具不等于任意用户可写记忆。状态和证据复用规则读[上下文与状态](../guides/context-and-state.md)，记忆的确认流程读[Memory](../guides/memory.md)。

## 类型主要维护位置

共享契约主要定义于 [analysis.ts](../../packages/contracts/src/analysis.ts)、[index.ts](../../packages/contracts/src/index.ts)、[memory.ts](../../packages/contracts/src/memory.ts) 和 [schema-enrichment.ts](../../packages/contracts/src/schema-enrichment.ts)。字段是否存在以源码为准；下表解释影响理解和修改的关键字段，不复制完整类型定义。

### 分析问题、运行快照和交付结果

| 对象 | 解决什么问题 | 关键字段含义 | 主要使用位置 |
| --- | --- | --- | --- |
| AnalysisState | 让多轮追问共享明确的任务与条件，也让旧证据能判断是否仍适用 | `taskId` 区分任务，`revision` 控制草稿并发；`memoryRefs` 选择知识及版本；`temporaryNotes.sourceMessageId` 记录写入临时约定的用户消息；时间、筛选、粒度和 `freshness` 限定复用；`hypotheses.evidenceIds` 记录依据，`openQuestions` 记录未决问题 | AnalysisStateRepository、patchAnalysisState、evidenceMismatch；[状态指南](../guides/context-and-state.md) |
| AnalysisRunSnapshot | 给 Prompt 和持久记录标明这次上下文来自哪一轮、哪个任务和哪一版状态 | `requestMessageId` 是当前问题消息；`timeAnchor` 是任务受理时的数据库时间；`stateRevision`、`memoryRefs`、`schemaTables` 记录当前选择和已加载表 | Adapter 每次组装上下文时构建；buildAnalysisPrompt、buildAnalysisData。它不是数据源行数据的历史快照 |
| AnalysisOutcome | 表达是否满足用户本轮问题，让完成度与系统执行成败分开 | `status` 是业务完成度；非完整状态需 `reason`，`missingItems` 只列真实缺失；`blocks` 类型允许结果引用，但当前 Adapter 输出元数据时置为空，正文和展示已独立流出 | validateFinish、AnalysisAgent、Adapter、AnalysisBlock；[Loop 指南](../guides/agent-loop.md) |
| ANALYSIS_RUNTIME_VERSIONS | 把任务和证据使用的策略版本记录下来，供排查当前结果使用了哪套运行约定 | promptPolicy/toolset/contextPolicy/memoryPolicy/schemaContext 各标识不同策略，不能只改一个版本名就视为所有策略已升级 | API 创建 generation、Adapter 上下文记录；当前值见下文 |

### 查询证据、图表和质量

| 对象 | 解决什么问题 | 关键字段含义 | 主要使用位置 |
| --- | --- | --- | --- |
| QueryPlanV1 | 记录这次查询为什么执行、每行应该代表什么，支持质量提示和证据解释 | `purpose` 是待回答的问题；`expectedGrain` 是行粒度；`expectedShape` 为 scalar/timeseries/category/detail，仅记录预期，不自动证明结果符合形态 | SqlQueryTool、assessResultQuality、ArtifactRepository |
| QueryArtifactV1 / QueryArtifactResultV1 | 给真实查询一个可回读 ID，使分析、表格、图表使用同一份保存结果 | `originalSql` 为提交 SQL，`executedSql` 为实际受限执行 SQL；`analysisContext` 保存状态、知识和访问指纹；`returnedRowCount` 为保存的返回行数，`totalRowCount` 可选且当前执行链不另行 COUNT；`resultContentHash` 是归一化并脱敏后行数据哈希。Result 以 `artifact` 包装元数据，并以 `rows` 保存结果行 | ArtifactRepository、Adapter、表格 API；[查询指南](../guides/sql-and-artifacts.md)。哈希并非每次回读都重新核验 |
| ArtifactColumnV1 | 告诉绘图和展示层如何解释已归一化的返回字段 | `name` 是结果列名；`type=number` 表示可安全绘图的数字，原始 PG 大数可能保留为 string，因此数据库 numeric 列不一定是 number | SqlExecutor 生成，GenerateChartTool 校验 |
| ChartArtifactV1 | 记录从哪份查询、按什么映射生成图表，供追溯 | `queryArtifactId` 是数据来源；`xField`、`yFields.field/label` 是字段映射和图例；`sort` 是展示排序。此对象不保存模型提交的数值数组 | GenerateChartTool、ArtifactRepository；发送给前端的数值在 `chartData` 中 |
| ResultQualityV1 | 提醒模型和用户哪些结果边界会影响结论，并阻止受限证据用于绘图或确认假设 | `isLimited` 与 `toolResultTruncated` 分别表示数据库返回限制、模型行摘要截断；`nullRates`、可选重复粒度和时间范围是检查结果；`warnings.severity` 分 info/warning/blocking，`action` 给出处理建议 | assessResultQuality、Adapter、状态更新、QueryEvidence；不是对业务结论正确性的认证 |

### 执行、活动与流事件

| 对象 | 解决什么问题 | 关键字段含义 | 主要使用位置 |
| --- | --- | --- | --- |
| GenerationStatus / GenerationErrorCode | 控制一次异步执行的生命周期，并区分超时、访问变更、SQL 拒绝、模型失败等原因 | status 决定能否认领、写入、取消和完成；errorCode 是程序分类标识，详细消息另存 error；`completed` 不代表业务分析必然 complete | API/Worker GenerationService、ChatService、Web chat store；[执行指南](../guides/generation-lifecycle.md) |
| GenerationJob / GENERATION_QUEUE_NAME | 用轻量队列通知 Worker 处理数据库内的任务 | 载荷只有 `version: 1`、`generationId`；Worker 解析后再读取数据库的任务和问题，不把整份会话复制进队列 | OutboxRelay、GenerationWorkerService、parseGenerationJob |
| AnalysisActivityV1 | 向用户展示确认条件、查看目录、查询、绘图等公开进度 | `id/groupId` 标识活动及分组；kind 是动作类型；status 是 running/completed/warning；`details` 是可读信息，query 记录实际 SQL 与行数，qualityMessages 给出限制；旧 warning 字段保留兼容 | AnalysisAgent 的活动包装、Web 活动块；并非原始模型思考日志 |
| ConversationEvent / GenerationStreamEvent | 前者描述一项业务事件，后者补足传输和恢复所需身份与游标 | `generationId/conversationId/messageId` 定位任务和回复；`sequence` 是单任务顺序；`streamId` 是用户 Redis Stream 游标；`eventId` 标识持久事件。两类游标不能互换 | PostgreSQL 事件、Outbox、用户 SSE、Web 缺口恢复；[流式通信指南](../guides/frontend-streaming.md) |

### 知识与字段注释

| 对象 | 解决什么问题 | 关键字段含义 | 主要使用位置 |
| --- | --- | --- | --- |
| MemoryContent / DatasourceMemory | 前者是一条自由文本定义，后者把定义变成已确认、可按版本引用的源内知识 | name/description 是口径文本；datasourceId 限定源；version、active/deleted 状态影响召回；source、confirmedBy、sourceMessageId 用于来源追溯 | MemoryRepository、API 管理页、Adapter 本轮固定记忆集合 |
| MemoryCandidate | 让模型提炼的知识先进入人工审核，避免直接改正式口径 | `version` 是候选的并发版本；`memoryId/expectedVersion` 是目标正式知识及其版本，二者不是同一个锁；generationId 关联任务，pending/accepted/rejected 为审核结果 | ProposeMemoryTool、候选确认 API、MemoryCandidateCard；[Memory 指南](../guides/memory.md) |
| RelatedMemory / MemoryNotice | 前者提示内容可能重复，后者向对话报告记忆处理结果 | reason 的同名/同内容/相似内容只是文本建议，不是语义冲突裁决；Notice 的 saved/pending/review_required/not_saved 分别指保存回执、候选等待、需要审阅或未保存 | 管理页查重、prepareConversationMemory、MemoryNoticeBlock |
| SchemaColumnComment / SchemaCommentSuggestion / SchemaCommentChange / SchemaEnrichmentResult | 分别承载当前字段信息、AI 建议、用户提交的修改和建议生成结果，把“生成”与“保存”分开 | suggestion 的 basis 说明来自原注释或样本，needsVerification 提醒待核实语义；change.originalComment 用于并发冲突校验，comment 为用户确定的新值；result.prompt 记录建议策略版本及哈希 | SchemaEnrichmentService、SchemaEnrichmentModal；[数据源指南](../guides/datasource-and-schema.md) |

### Worker 工具边界与 Web 表示

[base-tool.ts](../../apps/worker/src/chat/tools/base-tool.ts) 中，`Tool.definition` 提供模型看到的工具声明，`parseArguments` 验证模型输入，`execute` 真正运行。`ToolContext` 提供 AbortSignal、用户/源/任务身份、writerToken 与 assertWritable；analysisContext 把查询条件和选中知识传给查询证据。增加工具时，要同时考虑模型参数、执行权限、取消和证据上下文。

`ToolExecutionResult.toolResult` 是回给模型的字符串；`blocks` 是结果块，和工具经 emitter 发送的用户事件承担不同消费职责；`succeeded=false` 表达可反馈给模型的未成功调用，异常是否终止任务由 Loop 和壳处理。Worker 的 `SSEEvent` 是允许额外字段的宽接口，并不是每个 type 的严格判别联合。

[Web types](../../apps/web/src/types/index.ts) 的 `ChatMessage` 表示一条用户或助手消息，`content` 是纯文本，`blocks` 保存按顺序展示的文本、表格、图表、活动和通知；`animateText` 只用于当前批次文字播放，不能当持久执行状态。`MessageBlock.queryArtifactId` 支持表格后续读数据，`chartData` 直接供图形组件渲染。`AnalysisPresentation` 是附在文本块上的状态、选中记忆和业务 outcome 元数据，当前回复正文仍由普通文本块承载，避免重复播放。

当前版本字符串：prompt analysis-core-v3，toolset analysis-tools-v4，context analysis-context-v3，memory datasource-memory-v2，schema schema-context-v4。改定义时同时核对运行策略快照，并按需重生成参考。

## 三种状态不要混淆

- GenerationStatus：pending/starting/running/cancel_requested/completed/failed/cancelled，代表执行生命周期。
- AnalysisState.status：active或complete/partial/awaiting_clarification/unable_to_complete，代表业务交付情况。
- AnalysisActivityStatus：running/completed/warning，代表某工具公开活动；warning可能是查询成功但质量受限。

事件契约含兼容type不代表当前生产者发出；结果received/服务端rendered也不等于浏览器完成渲染。详细机制链接：[Loop](../guides/agent-loop.md)、[事件恢复](../guides/frontend-streaming.md)。
