# Gist Agent：AI Agent 深度面试题与参考答案

本文档基于 `README.md` 与 `server` 目录源码整理，问题视角按真实大厂面试场景设计，重点考察 AI Agent 架构、工具调用、上下文管理、SQL 安全、流式交互、记忆系统与生产化风险。

## 1. 这个项目为什么能被称为 Agent，而不是普通的 LLM Chat？

**问题深挖**

如果让你向面试官解释 Gist Agent 的核心架构，你会如何区分它和一个普通的“用户输入 -> LLM 输出”的聊天应用？

**参考答案**

它不是简单 Chat，因为 `ChatService.runAgentLoop` 实现了一个自管的 ReAct 循环：模型不是只生成文本，而是可以在多轮迭代中决定是否调用工具、接收工具观察结果、再继续推理，直到最终输出自然语言结论。

具体链路是：

- `ChatController.chat` 建立 SSE 响应。
- `ChatService.handleChat` 校验会话与数据源权限，写入用户消息。
- `PromptBuilder.buildSystemPrompt` 注入 Schema、业务口径和工作流规则。
- `ChatService.runAgentLoop` 将 `tools` 传给 OpenAI Function Calling。
- 模型产生 `tool_calls` 后，由 `ToolRegistry` 找到本地工具执行。
- 工具结果以 `role: tool` 消息重新塞回上下文，让模型继续判断下一步。

这符合 Agent 的几个核心特征：有目标、有工具、有环境反馈、有多步决策、有状态。普通 Chat 只有一次模型补全，不会主动执行 SQL、分析结果、生成图表，也不会把工具观察结果作为后续推理输入。

这个项目的 Agent 边界很清楚：`ChatService` 是主控 Orchestrator Agent，`execute_sql_query`、`analyze_result`、`generate_chart` 是被动 Tool，`SqlExecutorAgent` 是一个工具内部的子 Agent。

## 2. 为什么项目选择手写 ReAct Loop，而不是直接使用 LangChain / LangGraph？

**问题深挖**

如果你是项目负责人，为什么会接受手写 Agent Loop 的复杂度？它带来的收益和代价分别是什么？

**参考答案**

手写 ReAct Loop 的收益是控制力。这个项目不是开放域 Agent，而是强业务约束的数据分析 Agent，需要严格控制：

- 工具调用顺序：先查 SQL，再 `analyze_result`，必要时再 `generate_chart`。
- 前端事件粒度：SQL 生成、查询中、表格、图表、文本块都要通过 SSE 实时推送。
- 上下文存储格式：`blocks` 用于前端回放，`llm_messages` 用于下轮模型上下文。
- SQL 安全策略：工具执行前必须经过 AST 白名单、表权限、LIMIT 注入。
- 失败行为：语法错误可自愈，语义错误暴露给主 Agent。

如果使用通用 Agent 框架，很多行为会被框架抽象掉，尤其是流式 tool call 拼接、前端事件更新、消息持久化和 SQL 防腐层之间的细节联动，会变得不透明。

代价也明显：

- 需要自己维护 OpenAI 流式 `tool_calls` 的增量拼接逻辑。
- 需要自己处理迭代上限、超时、错误事件和消息一致性。
- 框架提供的 checkpoint、graph recovery、interrupt、human-in-the-loop 等能力这里没有。

所以这个选择适合当前项目规模：业务流固定、工具少、强控制优先。若未来工具数量扩大、分支复杂度上升，应该考虑把 `runAgentLoop` 升级为显式状态机或图执行模型。

## 3. 这个项目如何定义 Tool 和 Agent？`SqlExecutorAgent` 为什么不是普通 Tool？

**问题深挖**

项目里既有 `SqlQueryTool`，又有 `SqlExecutorAgent`。这两个名字看起来都在做 SQL，为什么要拆成 Tool 和 Agent？

**参考答案**

判断标准是自治度。

`SqlQueryTool` 是 OpenAI Function Calling 暴露给主模型的工具。它的职责是接收模型传来的 `sql` 参数，调用 SQL 执行能力，把结果包装成前端事件和 tool result。它是被动的。

`SqlExecutorAgent` 则有独立决策闭环：

- 解析 SQL AST。
- 判断是否只读。
- 校验是否越权访问表。
- 自动注入 `LIMIT 1000`。
- 执行查询并设置 15 秒超时。
- 区分语法错误和语义错误。
- 对纯语法错误调用内部 LLM 静默修复并重试。

这已经不是“一次输入一次输出”的工具，而是一个局部自治单元。它拥有自己的安全规则、错误分类策略、重试循环和专用 Prompt。

这种拆分是好设计：主 Agent 负责业务推理和任务编排，SQL 子 Agent 负责数据访问的安全闭环。否则 SQL 修复、AST 防护、重试和错误分类都会污染主循环，让主 Agent 既要做业务分析，又要做数据库防腐，职责会失控。

## 4. 这个 Agent 如何防止模型生成危险 SQL？

**问题深挖**

LLM 生成 SQL 天然不可信。这个项目有哪些防线？这些防线是否足够？

**参考答案**

项目在 `SqlExecutorAgent` 里做了几层防护。

第一层是 AST 白名单。`validate` 用 `node-sql-parser` 解析 SQL，只允许 `select`、`show`、`desc`、`describe`、`explain`，拒绝 `insert`、`update`、`delete`、`drop` 这类写操作。用 AST 比正则可靠，因为正则很难处理注释、子查询、CTE、多语句等绕过。

第二层是表权限校验。`SchemaService.getAllowedTableNames` 根据数据源和用户计算可访问表，`parser.tableList(sql)` 提取 SQL 涉及的表名，发现不在白名单内就阻断。

第三层是结果规模限制。`ensureLimit` 对没有 `LIMIT` 的 `SELECT` 注入 `LIMIT 1000`，防止模型一次性扫出过大结果集。

第四层是查询超时。`queryWithTimeout` 用 `Promise.race` 做 15 秒客户端侧熔断，避免长查询拖死交互。

第五层是 `SHOW TABLES` 二次过滤。即使 `SHOW TABLES` 被允许，结果也会再根据 `allowedTables` 过滤，避免泄露用户不可见表名。

这些防线是必要的，但不能说完美。风险点包括：

- `Promise.race` 只让上层提前返回，不一定真正取消 MySQL 正在执行的查询。
- `node-sql-parser` 的 `tableList` 对复杂 SQL、方言边界、函数或特殊语法的覆盖需要测试保证。
- `EXPLAIN`、`SHOW`、`DESC` 虽然只读，但仍可能暴露结构信息，所以表级过滤必须可靠。
- `ensureLimit` 只限制返回行数，不限制扫描成本。一个 `LIMIT 1000` 的复杂 Join 仍可能很重。

生产级方案还应叠加数据库只读账号、连接级超时、资源组限制、审计日志，以及按数据源隔离的最小权限账号。

## 5. SQL 自愈为什么只修语法错误，不修语义错误？

**问题深挖**

`SqlExecutorAgent.isSyntaxError` 只对 `ER_PARSE_ERROR`、`ONLY_FULL_GROUP_BY`、模糊列等错误触发 LLM 修复。为什么不让模型顺手修复“字段不存在”“表不存在”？

**参考答案**

这是这个项目里一个非常关键的工程判断：语法错误和语义错误的风险完全不同。

语法错误通常是局部问题，例如标点、GROUP BY 规则、聚合写法、列引用歧义。修复它不需要完整业务知识，内部子模型可以在没有全量 Schema 的情况下尝试调整 SQL 结构。

语义错误不同。字段不存在、表不存在、字段含义不匹配，必须依赖完整 Schema 和业务上下文。`SqlExecutorAgent.attemptFixSql` 的 Prompt 明确说明它没有完整 Schema，所以不能猜表名或字段名。如果让它修语义错误，本质上是在鼓励模型编造字段，数据分析结论会变成幻觉。

所以正确策略是：

- 语法错误：子 Agent 静默修复，最多 2 次。
- 语义错误：直接暴露给主 Agent，因为主 Agent 有 `PromptBuilder` 注入的 Schema，有资格重新生成 SQL。

这体现了 Agent 系统里的一个原则：错误应该回到拥有正确上下文的决策层处理。不要让低层工具用 fallback 掩盖上游推理错误。

## 6. 这个项目如何管理长期对话上下文？为什么不是简单把历史全塞给模型？

**问题深挖**

用户连续问很多轮数据分析问题时，如何保证模型既记得上下文，又不超出上下文窗口？

**参考答案**

`PromptBuilder` 做了三层上下文压缩。

最近 2 条历史保留 full 级别，即完整的 tool chain，但会脱水。比如 tool 结果不保留完整行数据，只保留行数和列名；`generate_chart` 的大数据参数会被替换为骨架。

中距离历史，也就是第 3 到第 6 条，使用 medium 级别。它把一整轮工具链压缩成一条 assistant 消息，只保留 SQL、结果行数和最终结论。

更早历史使用 compact 级别，只保留纯文本结论。

选择策略是从最新消息往旧消息扫描，根据 `MAX_CONTEXT_TOKENS - systemTokens - RESPONSE_RESERVE - TOOLS_RESERVE` 算出历史预算，然后选择能放进去的最高压缩级别。

这比全量塞历史更适合数据分析 Agent，因为 SQL 查询结果和图表数据非常大，保留原始数据会迅速撑爆上下文。而真正需要长期保留的是：用户问题、执行过的 SQL、结果规模、分析结论和业务口径。

但这个实现也有风险：

- `token-estimator.ts` 是启发式估算，不是模型真实 tokenizer。
- `TOOLS_RESERVE = 1500` 是固定值，工具定义变多后可能低估。
- 远距消息如果只保留文本结论，会丢失生成结论的证据链。
- `selectEntriesWithinBudget` 放不下某条消息时会继续尝试更早消息，这可能造成历史语义不连续。

生产中可以进一步引入精确 tokenizer、按 conversation turn 成组裁剪、摘要校验、以及按问题召回相关历史，而不是只按时间窗口保留。

## 7. 语义蒸馏解决了什么问题？它和 RAG 有什么区别？

**问题深挖**

`SemanticDistillerService` 每轮对话后异步更新 `semantic_state`。它到底解决什么问题？为什么不直接依赖历史消息压缩？

**参考答案**

历史压缩解决的是“放不下”的问题，语义蒸馏解决的是“不能丢”的问题。

数据分析对话中，有些信息不是查询结果，而是用户定义的业务口径，例如：

- “活跃用户指登录且发生消费的用户”
- “有效订单不包含退款订单”
- “北区包含北京、天津、河北”

这些定义可能出现在很早之前，但后续所有 SQL 和结论都要遵守。仅靠 compact 历史很容易丢掉这些口径。

`SemanticDistillerService` 的做法是：每轮结束后，用一个后台 LLM 从用户消息里抽取业务名词定义，写入 `conversation.semantic_state.definitions`。下一轮 `PromptBuilder.buildSystemPrompt` 会把这些 definitions 注入 System Prompt。

它和 RAG 的区别是：

- 语义蒸馏是结构化状态更新，写入的是当前会话的业务口径。
- RAG 是从外部知识库检索相关文档，通常是无状态或弱状态。
- 蒸馏强调“会话内长期记忆”，RAG 强调“外部知识召回”。

当前实现的风险也很明确：

- 它是 fire-and-forget，失败不会影响本轮回答，但下一轮可能缺记忆。
- 它只看 `userMessage`，没有看 assistant 最终结论和工具结果，因此不会沉淀查询事实。
- JSON 解析靠正则截取 `{...}`，对模型输出格式依赖较强。
- 并发多轮请求可能出现状态覆盖问题。

如果生产化，应当引入版本号或乐观锁，并把“业务定义”和“数据事实”分开存储，避免用户口径和查询结果混在一起。

## 8. 这个 Agent 如何保证“先查数据，再分析，再画图”的流程？现有实现有什么漏洞？

**问题深挖**

README 说工作流是“SQL 生成 -> 结果分析 -> 图表输出”。从源码看，这个顺序是硬约束还是软约束？

**参考答案**

目前主要是软约束。

约束来源有两处：

第一处是 System Prompt。`PromptBuilder.buildSystemPrompt` 明确要求：

- 先调用 `execute_sql_query`
- 再调用 `analyze_result`
- `needsChart=true` 时才调用 `generate_chart`
- 最终文字总结必须在所有工具调用完成后输出

第二处是工具描述。`AnalyzeResultTool.definition` 写明它必须在 SQL 之后、图表之前调用；`GenerateChartTool.definition` 写明只能在 `analyze_result` 返回 `needsChart=true` 后调用。

但 `ChatService.runAgentLoop` 本身没有状态机校验。也就是说，如果模型跳过 `analyze_result` 直接调用 `generate_chart`，代码仍然会执行。如果模型在工具调用过程中输出文本，代码也会把 `text_chunk` 推给前端。

这在面试里是一个很好的追问点：Prompt 不是强约束，Tool description 也不是强约束。真正强约束应该在 Orchestrator 层维护状态机，例如：

- 初始状态只能调用 `execute_sql_query`。
- 有 SQL 结果后只能调用 `analyze_result` 或结束。
- `needsChart=true` 后必须调用 `generate_chart`。
- `generate_chart` 的数据必须来源于最近一次 SQL 结果。

当前实现更轻，适合原型和小规模场景；生产级 Agent 应把关键业务流程从 Prompt 约束下沉到代码状态机。

## 9. SSE 流式输出在这个 Agent 里承担什么职责？它的生产风险是什么？

**问题深挖**

这个项目为什么用 SSE，而不是等 Agent 完整执行完再返回 JSON？

**参考答案**

Agent 执行天然是多阶段、长耗时的。一次数据分析可能包含模型思考、SQL 生成、SQL 执行、结果分析、图表生成、最终总结。如果等完整结果，用户会长时间看不到反馈。

`StreamEmitter` 通过 SSE 推送事件，让前端实时展示 Agent 状态：

- `text_chunk`：模型文本增量。
- `log` / `log_update`：工具调用过程。
- `sql`：生成的 SQL。
- `table`：查询结果。
- `chart_loading`：图表生成中。
- `chart`：图表配置。
- `error`：错误。
- `done`：结束。

同时，`ChatService` 会把这些 SSE 事件收集到 `blocks`，写入 `message_block`，用于历史回放。这是很实用的设计：实时输出和持久化展示复用同一套事件模型。

生产风险包括：

- `StreamEmitter.send` 直接 `res.write`，没有处理背压。
- 没有心跳事件，经过代理或网关时长连接可能被断开。
- `CHAT_TIMEOUT_MS` 通过 `Promise.race` 返回错误，但没有真正取消 OpenAI stream 或 MySQL query。
- 客户端断开连接时，后端没有显式停止 Agent Loop。
- 如果达到 `MAX_AGENT_ITERATIONS` 仍未完成，当前循环会自然退出，但没有统一的“达到迭代上限”错误事件。

生产级实现应该加入 AbortController、请求取消传播、心跳、背压处理、客户端断开监听，以及明确的迭代上限错误。

## 10. 如果要把这个 Agent 推到生产，你最担心哪三个技术风险？怎么改？

**问题深挖**

你作为技术负责人，评估这个项目从 Demo 到生产，最优先要补哪几个点？

**参考答案**

第一是流程强约束不足。

当前依赖 Prompt 约束工具调用顺序，模型仍可能跳步。应把 `runAgentLoop` 改成显式状态机，校验每个工具调用是否合法，尤其是 `generate_chart` 必须绑定最近一次 SQL 结果，不能让模型自己构造数据。

第二是取消和资源治理不足。

`CHAT_TIMEOUT_MS` 和 SQL 的 15 秒超时都是 `Promise.race`，对用户表现为超时，但底层请求可能仍在运行。应引入 AbortController 取消 OpenAI 请求，MySQL 层使用真正的查询超时或 kill query，同时监听 SSE 客户端断开事件。

第三是上下文和记忆一致性不足。

`PromptBuilder` 的 token 估算是粗略的，`SemanticDistillerService` 异步更新可能失败或并发覆盖。应使用真实 tokenizer，按 turn 级别裁剪历史，并给 `semantic_state` 加版本控制。业务口径更新还应支持冲突处理，例如用户重新定义“活跃用户”时，需要覆盖旧定义，而不是简单合并。

如果继续深挖，还可以补：

- 工具参数解析失败不能静默变 `{}`，否则模型意图和工具执行会错位。
- SQL 自愈后的 SQL 应再次经过完整 AST 校验，当前代码确实会回到循环重新 validate，这是正确点。
- Schema Enrichment 会把 LLM 推断写入 `COLUMN_COMMENT`，这能提升 SQL 生成质量，但也会把模型误判固化到元数据里，应该有人工校验或置信度机制。
- LangSmith 包装能追踪 LLM 调用，但业务级 trace 还需要把 conversationId、datasourceId、toolName、sqlHash、latency 等结构化字段打进日志。

## 面试官追问清单

下面这些追问通常能区分候选人是否真的理解 Agent 工程，而不是只背概念。

1. 如果模型流式返回的 `tool_calls.function.arguments` 是半截 JSON，你如何保证拼接正确？
2. 为什么 `JSON.parse(argsStr)` 失败后静默使用 `{}` 是危险设计？
3. `LIMIT 1000` 能控制返回规模，但为什么不能控制查询成本？
4. 为什么 SQL 修复 Agent 不能拥有完整 Schema？如果给它完整 Schema 会有什么代价？
5. `blocks` 和 `llm_messages` 为什么要分开存？只存一种行不行？
6. 语义蒸馏为什么只抽业务定义，不抽查询结果？
7. 如果用户在第 10 轮重新定义业务口径，旧的 `semantic_state` 应该怎么处理？
8. 如何防止模型在 `generate_chart` 里传入非 SQL 结果的数据？
9. 如果 OpenAI stream 中断，前端历史应该如何保持一致？
10. 这个 Agent 如果接入更多工具，`ToolRegistry` 还够不够？什么时候应该升级为 Planner / Executor 架构？

## 总结

这个项目最值得讲的不是 NestJS，而是一个数据分析 Agent 的工程化落地：

- 主控 Agent 用手写 ReAct Loop 做编排。
- 工具系统用 OpenAI Function Calling 暴露能力。
- SQL 执行通过 AST 白名单、权限校验、LIMIT 注入和语法自愈做防腐。
- 上下文通过 full / medium / compact 三层压缩控制 token。
- 长期业务口径通过语义蒸馏写入 `semantic_state`。
- 前端体验通过 SSE 事件流和 `blocks` 持久化统一建模。

面试回答时不要只说“用了 ReAct”或“用了 Function Calling”。真正有价值的是讲清楚：哪些约束交给 Prompt，哪些约束必须下沉到代码；哪些错误可以自动修，哪些错误必须暴露；哪些上下文应该保留证据链，哪些可以压缩成摘要。这才是 Agent 工程和普通 LLM Demo 的分水岭。
