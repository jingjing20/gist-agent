# 数据语义、上下文与记忆设计

用途：区分知识和状态的生命周期，说明确认及复用边界。适用读者：产品、Agent、数据源维护者。

## 四类信息

| 信息 | 作用和范围 | 存储/来源 | 进入模型的方式 |
| --- | --- | --- | --- |
| 会话历史 | 理解当前会话之前问答 | message、conversation_turn | 同数据源最近最多四个 completed Turn 的问题和 final_answer |
| 执行上下文 | 当前 generation 的工具协议和工作数据 | 内存、llm_messages、context_reports | 每次模型调用重新按预算选择 |
| 业务知识 | 表字段含义和复用口径 | PostgreSQL 注释、datasource_memory_revision | get_schema / read_memory / state.memoryRefs |
| 分析状态 | 同一会话的任务条件、假设及待澄清项 | analysis_state 与草稿 | 必选分析数据段 |

**已确认**：长期记忆按数据源共享，能跨会话复用；没有用户画像记忆、全局知识库或向量检索。自由文本 Memory 的内容只有 name 和 description，不是强类型指标 DSL。

## Schema 语义

目录定义哪些物理表对 Agent 可见；SchemaService 从 information_schema 和 PostgreSQL 注释读取字段类型和说明。模型按需分页发现，不会在每问前自动理解全库关系。

字段注释增强是独立功能：用户选择列 → 程序读取结构、原注释及最多五行允许字段样本 → LLM 提建议 → 用户审核 → 保存正式 COMMENT。建议含 original_metadata/sample_observation 依据标签和 needsVerification；仅生成建议不改正式注释。保存检查原注释是否变化以避免覆盖。细节见 [数据源指南](../guides/datasource-and-schema.md)。

## 正式记忆与候选

[MemoryRepository](../../packages/database/src/memory-repository.ts) 将当前记录与 revision 分离；同源活动记忆规范化名称唯一，修改/软删除增加版本，保留历史内容及确认人。读取授权与数据源一致，写入仅所有者。

两种来源均标记 manual/conversation，实际入口有三类：

1. 记忆管理页人工保存：直接正式写入。
2. 明确且边界清晰的“记住：…”：确定性 parseMemoryIntent 判定；新内容无相似匹配可直接保存；不依赖本轮分析成功，取消或失败不会撤销。
3. 模型提炼、修改或混合请求：生成候选；候选仅 owning generation completed 后可见/确认，确认时可编辑、合并或替换指定版本。

相关性检测只是规范名称、文本相等与二元字符重叠提示，不是语义矛盾判断，也没有自动覆盖冲突知识。

## 快照与跨轮状态

[AnalysisStateRepository.begin](../../apps/worker/src/analysis/analysis-state.repository.ts) 在 Worker 开始时获得当前正式 Memory 快照；管理页并发修改于下一轮生效。generation 上 `context_upper_bound` 是请求时的历史上界/时间锚点，**不是 Memory 或 Schema 的数据库时间点快照**。

状态含 taskId、question、memoryRefs、temporaryNotes、timeRange、comparisonRange、filters、grain、freshness、hypotheses、openQuestions。追问默认沿用同数据源状态；模型 `start_new_task` 清空旧条件。数据源变更自动起新状态；条件变化清空已有假设。

每轮在 analysis_state_draft 保存修改；只有 generation completed 时同事务提升为 analysis_state。失败/取消草稿不影响下一轮有效状态。正式 Memory 是独立知识写入，生命周期与分析草稿不同。

## 可追溯与局限

查询证据捕获使用的状态、Memory 版本、访问指纹；当前 source_message_id 留存于正式记忆 revision，即便源会话删除也不撤销知识。候选与源消息/任务级联删除。

预算选择优先保留规则、当前问题、状态及最新完整工具批次；完整性超过预算则失败，不截断必要协议。目录/旧证据/较早问答可被省略，选择报告和哈希可追查。没有自动摘要/语义压缩或全量会话回放。

**推断**：这种设计优先保证口径和条件可追踪；不能因此断言模型必定读完/采用正确知识。规则、状态版本和人工确认减少风险，仍需检查实际 SQL。实现入口见 [上下文指南](../guides/context-and-state.md) 和 [Memory 指南](../guides/memory.md)。
