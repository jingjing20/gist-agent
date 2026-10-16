# 调试入口、已观察问题与待确认事项

用途：区分源码可证的限制、可能影响和运行待确认问题。适用读者：维护者与后续AI Coding。这里只记录，不修改业务代码；下面不是已执行的运行复现或安全漏洞报告。

## 现状问题与证据（实现事实、影响推断分列）

| 项目 | 已确认实现 | 影响/判断 | 后续需要确认 |
| --- | --- | --- | --- |
| 状态与SQL一致性 | patch校验状态，SQL工具接受模型字符串，没有将条件编译/等价校验 | 状态快照可追溯，但不保证SQL遵循业务条件 | 是否需要针对关键口径的确定性检查 |
| 查询截断标记 | 外层LIMIT1000，extractLimit匹配SQL首个LIMIT | 内层LIMIT可能导致isLimited误判；达到上限也只能判断可能截断 | 以运行案例验证嵌套/UNION/内层限制 |
| 粒度质量检查 | expectedGrain文字包含列名才选择重复键字段 | 无法证明JOIN无放大/比率正确；空集不等于0 | 重点业务的可验证质量约束 |
| Schema上下文 | getSchemaDetail省略structured Schema的masked标记；accessFingerprint只含表名和列策略 | 模型可能误用脱敏字段而触发停止；结构/注释变化不必触发旧证据失效 | Schema版本与证据复用政策 |
| 文件列名 | 清洗+重复后缀，无最终全局碰撞/63字节长度规范 | 不同原表头a!、a?、a_1清洗后可能生成a、a_1、a_1；长/多字节标识符可能由PG截断 | 导入错误反馈及列名策略 |
| Agent取消连接 | pg_cancel_backend通过同agentPool申请连接 | pool全占用时取消请求可能等待；15秒statement_timeout仍是防线 | 并发满载下取消实际延迟 |
| 模型快照 | API记录model_name/provider，Worker实际读自己env的单个LlmClient | 配置漂移时记录与执行模型可能不一致 | 是否应将generation模型配置作为执行依据 |
| 历史流恢复 | 初始sync；后续只重连SSE；未知generation首帧跳号时resync无current直接返回，snapshot也不创建缺失消息 | 旧终态/流过期可能无新事件触发恢复；首次跳号可能被推进stream游标而未应用，快照可能落后事件正文 | 首帧/202竞争、长离线、多标签、done丢失与缺消息的验收 |
| 权限变更后历史展示 | Artifact API重算指纹；conversation消息仍返回历史blocks/llm_messages | 已存chartData、活动细节和协议行不走同样指纹检查 | 撤销访问后历史数据应如何展示/保留 |
| 取消结果分类 | cancel_requested先写库，轮询abort与writer检查分别发生；后者只接受starting/running | 源码推断：轮询前writer检查可先抛WRITER_OWNERSHIP_LOST，任务可能failed而非名义cancelled | 取消/工具边界/事件发布的竞争验收，见生命周期指南 |
| 数据保留 | PG事件/草稿/证据无当前自动清理；RedisTTL按键刷新 | 长期储存规模与删除政策未明确 | retention、成本与审计政策 |
| tracing与内部reasoning | wrapOpenAI；llm_messages可带reasoning_content；getMessages返回m.* | UI隐藏不等于未存储/未传客户端，部署tracing开关决定外发 | 数据采集、读取字段与内部reasoning保留要求 |
| 迁移 | CREATE IF NOT EXISTS+基础列类型检查；迁移包含删除/可选重置 | 并非各历史Schema自动完整升级，检查不覆盖全部约束 | 真实部署版本及兼容路径 |
| 健康与指标 | /health只回进程ok；generation.error span和估算计数 | 无端到端可用性证明，估算token非账单，错误span非全链路性能分析 | 运行监控要求与实际LangSmith采集范围 |

代码依据：

- [patchAnalysisState / evidenceMismatch](../../apps/worker/src/analysis/analysis-state.ts)、[SqlExecutor.ensureLimit / extractLimit](../../apps/worker/src/chat/tools/sql-executor.ts)、[assessResultQuality](../../apps/worker/src/chat/result-quality.ts)。
- [SchemaService.getSchemaDetail](../../apps/worker/src/database/schema.service.ts)、[Adapter.accessFingerprint](../../apps/worker/src/analysis/analysis-runtime-adapter.ts)。
- [上传Controller](../../apps/api/src/datasource/datasource.controller.ts)、[queryReadOnlyWithFields](../../packages/database/src/index.ts)。
- [API generation](../../apps/api/src/chat/generation.service.ts)、[LlmClient](../../packages/llm/src/index.ts)、[chat Store.startRealtime](../../apps/web/src/stores/chat.ts)。
- [Artifact Controller](../../apps/api/src/analysis-artifact/analysis-artifact.module.ts)、[ConversationService.getMessages](../../apps/api/src/conversation/conversation.service.ts)、[HealthController](../../apps/worker/src/health.controller.ts)、[Schema校验](../../packages/database/src/schema-validation.ts)。

## 调试前先确定对象和证据

排查应先确定一个generation，而不是只凭用户说“这次分析失败了”。同一conversation可以有多个历史generation，retry新建一轮；同一轮也可以有多次SQL和多个Artifact。

| 标识/字段 | 解决什么定位问题 | 通常从哪里取得 |
| --- | --- | --- |
| conversationId | 哪个会话、哪个用户上下文 | 路由、会话请求/列表 |
| generationId | 哪一次执行、取消/重试/事件归属 | POSTchat回执、message附带generation_id |
| responseMessageId | 哪条assistant消息接收blocks/快照 | POSTchat回执、generation.response_message_id |
| queryArtifactId | 哪次成功查询、哪份数据/SQL/条件 | 工具结果、活动query、图/表block |
| writer_token及心跳 | 当前执行者是否仍有写入权 | generation记录；日志只记录必要标识 |
| sequence与streamId | 单任务逻辑位置和用户Redis投递位置 | 持久事件/Store与SSE载荷 |

收集顺序是“用户操作与时间 → 请求响应 → 当前任务记录 → 对应事件/证据 → 相关日志”。不将真实JWT、密码、重置链接或敏感结果行复制到问题文档。这里的字段与后续查询都是定位建议，本次没有连接真实服务。

## 按症状找到第一处断点

| 症状 | 检查顺序 | 关键字段/符号 |
| --- | --- | --- |
| 提问立即失败 | Web响应 → Controller/startChat → createTurn | 401、409、429、幂等键与request_hash |
| 创建成功但长期pending | enqueue Outbox → API Relay → BullMQ →容量租约 | published_at/last_error/dead_lettered_at、queue名、semaphore |
| running却无输出 | claim/attempt/心跳 → Adapter访问 →上下文 →模型 | writer/heartbeat、context_reports、first_token_at、error_code |
| SQL失败 | tool反馈 →AST/授权 →PG执行 →证据保存 | original/executed SQL、SQL_VALIDATION_FAILED、57014 |
| 表格可看但无法绘图 | observed →条件signature →质量 →字段类型 | queryArtifactId、blocking、isLimited、unknown |
| 新表不在分析目录 | 源访问 →catalog/is_agent_visible →真实schema →角色SELECT | table_name与display_name、masked/deny |
| SSE断流/乱序 | PG事件 →Outbox →Redis用户流 →Store补洞 | sequence、streamId、history.mode |
| 文字重复或阅读跳动 | Adapter.emit →applyBlock →播放/滚动 | analysis、display、animateText、playingTextCount |
| Memory未复用/候选不见 | 源所有者/版本 →snapshot →memoryRefs →generation终态 | expectedVersion、completed、sourceMessageId |

## 场景一：提问返回202，却没有开始分析

教学案例：浏览器已拿到generation G的202回执，但长时间没有正文。不要马上把它归因于模型慢；202只确认创建事务完成。

1. **确认generation是否仍pending。** 若已经failed，看error_code；若已running，进入场景二。会话列表刷新与模型执行是不同信号。
2. **看G的generation.enqueue Outbox。** 没有published_at，且last_error是Redis连接/载荷错误时，断点可能在Relay；有dead_lettered_at表示无效载荷被隔离。不要将published_at空白自动解释为Worker没启动。
3. **已投递则检查队列配置。** API和Worker的Redis URL、队列名conversation-generations是否一致，Worker是否ready。jobId用generation UUID，重复Outbox投递不应当作两次模型执行。
4. **检查容量与claim。** Worker需要全局/提供商/用户租约，再条件领取pending；容量不足可引发队列重投。若generation已starting/running，新job不会从头恢复同一次执行。
5. **最后看排队超时。** 运行中的Worker监测器默认按十分钟阈值终结pending；监测只注册在Worker中，全部Worker停机时不会自行收敛。错误回执和已有消息与“继续等待”不是同一结果。

由平台维护账号做只读检查时，查询可以只取非敏感状态字段；下面是驱动bind参数示意，`$1`代表目标UUID，不是本次执行记录：

```sql
SELECT g.id, g.status, g.error_code, g.started_at, g.writer_heartbeat_at,
       o.type, o.published_at, o.dead_lettered_at, o.attempts, o.last_error
FROM generation g
LEFT JOIN outbox_event o ON o.aggregate_id = g.id AND o.type = 'generation.enqueue'
WHERE g.id = $1::uuid;
```

平台内部表不应通过Agent数据查询工具访问。具体执行壳与Relay职责见[生命周期](generation-lifecycle.md)。

## 场景二：有过程说明，随后失败或停住

1. 先区分执行状态和业务outcome。业务unable_to_complete也可以generation completed；这时通常是明确交付边界，而不是未写终态。
2. generation failed时从error_code起读：LLM_REQUEST_FAILED偏模型/响应流，CONTEXT_BUDGET_EXCEEDED偏必选上下文，TOOL_EXECUTION_FAILED偏工具异常，WORKER_LOST偏过期监测。代码分类不能替代原始服务日志。
3. 查最近analysis_activity和工具protocol，定位最后成功动作；不要把最后一条“正在…”认为仍有后台执行者。first_token_at表示首次文本、reasoning或tool delta，不一定是首段用户正文。
4. 查writer_heartbeat_at与attempt，判断是否真正失联。旧执行者丢writer不能继续写消息/草稿/证据/普通事件，监测可终结；这不是checkpoint自动恢复功能。
5. 正常取消路径的cancelled保留已有块，失败草稿不提升；重试原问题新建generation并重新选择上下文，不从最后一条日志续跑。取消轮询前writer检查可能先报错的竞争边界见[生命周期指南](generation-lifecycle.md)，尚未运行复现。

可检查持久事件是否到达终态，避免只看Web文字播放：

```sql
SELECT sequence, event_type, created_at
FROM generation_event
WHERE generation_id = $1::uuid
ORDER BY sequence;
```

`generation_metric`是估算计数，`generation_trace_span`当前主要记录error，不是每个工具的完整性能轨迹。模型输入候选选择从草稿context_reports及analysis元数据查，详见[上下文指南](context-and-state.md)。

## 场景三：查询有结果，图表却被拒绝

沿同一个queryArtifactId按以下顺序检查，不先要求模型重画：

1. 本轮是否已经查询或read_query_artifact观察此证据？Loop对绘图按批次开始前的observed检查，同一批查询成功不能立即授权同批绘图。
2. 是否同源、同task、匹配时间/定义/筛选/粒度？state revision数不同不一定不可用，比较的是条件signature。用户要求最新时，历史回读也不能代替本轮查询。
3. 是否有RESULT_LIMITED、TOOL_RESULT_TRUNCATED、DUPLICATE_GRAIN等blocking质量？查询执行成功不代表它足以支持图表或总体结论。
4. x/y字段是否真实存在且数值列可以安全转换？超大整数可能是unknown，scatter的X也要number；pie/funnel只允许一个y系列。
5. 若server工具已返回rendered、chart事件也被持久投递，再查前端chartData与ECharts；服务端rendered不证明浏览器渲染完成。

依据：[AnalysisAgent](../../apps/worker/src/analysis/analysis-agent.ts)、[Adapter](../../apps/worker/src/analysis/analysis-runtime-adapter.ts)、[GenerateChartTool](../../apps/worker/src/chat/tools/generate-chart.tool.ts)。完整数据对象变化和安全示例见[SQL与Artifact](sql-and-artifacts.md)。

## 场景四：完成记录存在，前端消息却不完整

先区分三个持久层：generation_event记录有序事件；Outbox记录待投递；message记录checkpoint/终态快照。它们在过程中并非每token同步更新成同一内容。

- **PG已有done、Outbox仍未投递**：断点在Relay或Redis，可看到last_sequence已大于浏览器位置；不能把数据库last_sequence当成Redis已经投递的位置。
- **Redis已投递、浏览器跳号**：Store按generation.sequence检测gap，调用history；连续事件则补回，无法形成合适连续链时用snapshot。详见[前端恢复示例](frontend-streaming.md)。
- **snapshot返回但界面没出现消息**：当前resync仅替换已存在消息，不能假定它会创建缺失assistant对象；也没有按快照error自动生成错误块。
- **收到done后仍有文字逐字显示**：这是Markdown播放继续排空；不要等同于Worker还运行。播放状态和generation状态应分别排查。
- **旧图还能看、点击依据报409/404**：消息中chartData和重新读取Artifact走不同授权路径；核对用户/会话/源权限以及accessFingerprint变化，不能将一份旧展示误认作新查询。

## 场景五：口径看起来保存了，却没有应用

先查应用memory_notice与正式Memory版本，不只读模型正文。明确记住的直存发生在本轮Memory快照之前，可能进入本轮目录；候选只有completed后可确认，新正式版本不会回写已经结束的本轮快照。

“正式存在”“已被模型读取”“state.memoryRefs选中”“SQL按定义落实”“前端展示采用口径”是不同环节。shared源用户可能只有读权限；同源所有者才能写/确认。记忆管理页修改并不触发旧分析自动重算。

若当前refs版本与最新不同，检查是否本轮固定快照；若下一轮旧ref被移除，检查memoryChanges和待澄清项。具体正常/冲突/软删除案例见[Memory指南](memory.md)。

## 修改后如何验证本领域

默认选快速、非交互检查，验证要针对行为变化：协议变化至少核对事件载荷、Store映射和历史恢复；条件变化核对signature与state校验；Schema变化核对字段读写方及迁移；知识变化核对版本和候选确认。代码类型通过只是其中一项，不能代替语义/交互判断。

需要运行浏览器E2E、故障注入、真实查询或模型验收时另按用户明确授权进行。本次只有docs变化，执行文档检查并保留运行待确认项，不实际执行本页SQL/操作建议。

## 尚不能从代码回答

目标行业和产品优先级、真实上线数据源目录/字段政策、实际DB角色权限、实际模型稳定性与费用、并发规模、备份恢复/保留需求、架构选择的历史备选与原因。若需要这些结论，须由维护者提供资料或另行授权运行检查；当前文档不虚构。

没有运行浏览器E2E、模型/SMTP/真实数据库集成、长时间可靠性和全量回归；静态链路已覆盖当前核心模块，运行效果由后续验收确认。
