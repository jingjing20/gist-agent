# 逆向分析进度

用途：保存代码分析证据、覆盖范围及恢复入口。读者：维护者和后续 AI Coding 会话。

## 基线与边界

- 分析日期：2026-10-14；基线提交：`ce5dbfb`，**以当前含未提交修改的工作区为准**，不是该提交的纯净版本。
- 启动前已检查 Git 状态：业务代码、配置、旧文档删除均为已有变更；仅新建 `docs/` 文档，不恢复已删除文档。
- 已确认 = 直接源代码或配置依据；推断 = 对当前结构的解释；待确认 = 缺少证据。静态分析不等于部署或交互验收。
- 不读取真实 `.env`，不连接业务数据库或外部服务，不执行初始化、迁移、业务写入或交互测试。

## 阶段

| 阶段 | 状态 | 产出 |
| --- | --- | --- |
| 1 全局扫描 | 已完成 | 下方模块地图、入口与主链路 |
| 2 设计文档 | 已完成 | 七篇设计文档，覆盖主要产品与架构 |
| 3 实现指南 | 第二轮已深化完成 | 十篇指南，涵盖开发、执行、SQL、上下文、持久化、Memory、Schema、前端与排查 |
| 4 决策及参考 | 已完成 | 两条证据型ADR、待确认决策、API/Schema生成器、配置/工具参考 |
| 5 交叉验证 | 已完成（静态范围） | 生成索引一致、链接/导航/图结构/敏感模式/写入边界；见VALIDATION |

## 模块地图

| 模块 | 关键入口 | 分析状态 |
| --- | --- | --- |
| 账号与认证 | `apps/api/src/auth/auth.controller.ts`、`apps/web/src/stores/auth.ts` | 已完成静态链路 |
| 会话与消息 | `apps/api/src/conversation/conversation.service.ts` | 已完成静态链路 |
| API 任务创建和订阅 | `apps/api/src/chat/generation.service.ts` | 已完成静态链路 |
| 队列及执行可靠性 | `apps/api/src/chat/outbox-relay.service.ts`、`apps/worker/src/chat/chat.service.ts` | 已完成静态链路 |
| Agent Loop | `apps/worker/src/analysis/analysis-agent.ts` | 已完成静态链路 |
| 分析运行适配 | `apps/worker/src/analysis/analysis-runtime-adapter.ts` | 已完成静态链路 |
| 分析状态与上下文 | `apps/worker/src/analysis/analysis-state.ts`、`context-assembler.ts` | 已完成静态链路 |
| SQL 与查询证据 | `apps/worker/src/chat/tools/sql-query.tool.ts`、`sql-executor.ts` | 已完成静态链路 |
| 图表与结果质量 | `apps/worker/src/chat/tools/generate-chart.tool.ts`、`result-quality.ts` | 已完成静态链路 |
| 数据源上传及权限 | `apps/api/src/datasource/datasource.service.ts` | 已完成静态链路 |
| Schema 与注释增强 | `apps/api/src/database/schema.service.ts`、`apps/api/src/datasource/schema-enrichment.service.ts` | 已完成静态链路 |
| 数据源记忆 | `packages/database/src/memory-repository.ts` | 已完成静态链路 |
| 前端事件及结果呈现 | `apps/web/src/stores/chat.ts`、`components/ChatMessageItem.vue` | 已完成静态链路 |
| 共享契约及数据库 | `packages/contracts/src/index.ts`、`packages/database/src/schema.ts` | 已完成静态链路 |
| 启动及交付配置 | `package.json`、`docker-compose.yml`、各应用 `main.ts` | 已完成静态链路 |

## 已确认结论

1. Vue/Pinia 前端、NestJS API 和独立 BullMQ Worker；共享 config/contracts/database/llm 包。依据：各 `package.json` 与 `app.module.ts`。
2. API 将消息、generation、conversation_turn 和入队 outbox 写入同一事务；分析主模型执行在 Worker，API仍有推荐与注释增强辅助模型调用。依据：API `GenerationService.createTurn`、Worker `ChatService.executeGeneration`。
3. 分析是原生流式 Tool Calling 单循环；`finish_analysis` 独立收尾，状态修改也必须独立调用。依据：`AnalysisAgent.run`。
4. 授权数据源是平台 PostgreSQL 的表目录；上传文件建表后注册目录。`source_type=external` 是目录枚举，不能据此断言远程连接能力。依据：`DataSourceService.uploadTable`、`data_source` Schema。
5. 已读代码具有版本化记忆、分析状态草稿、查询 Artifact、持久事件等实体；事务与访问约束已核对，见设计和指南。

## 历史证据与未覆盖边界

- 读取了近期提交标题用于定位；针对业务源码核对：`de269aa`中的单Loop边界注释、`5a6b8f6`中的草稿同事务/会话锁说明、`ce5dbfb`旧SQL执行器AST理由。未读取或恢复历史docs正文。
- 两条ADR仅记录上述明确注释支持的理由；框架、数据库、队列、文本Memory等历史备选/批准过程待确认，见[决策待确认](decisions/pending-decisions.md)。
- 主要产品/技术模块已完成静态分析，没有未读的核心主链路阻碍文档交付；没有逐行解释通用UI组件或简单CRUD，不把它们认定为另一个文档阶段。
- 未做：生产Schema/角色/配置核对，真实模型和数据库集成，浏览器E2E/GUI、性能/故障注入、完整回归、线上部署/备份恢复验证。均不是此次只读代码与docs范围内的验证。
- 重点待确认：SQL语义与状态一致性、截断标记、权限变化后历史载荷、Memory/事件保留、实际Provider能力及上线配置；完整证据见[问题记录](guides/risks-and-open-questions.md)。

## 完整交付索引

- [docs导航](README.md)：各目录README、推荐阅读顺序和持续维护约定。
- [design](design/README.md)：7篇设计，覆盖产品、架构、Agent、分析引擎、知识、前后端与数据库。
- [guides](guides/README.md)：10篇指南，覆盖环境、任务/SQL/流链路、状态、数据库持久化、Memory、Schema与排查。
- [decisions](decisions/README.md)：2条有源码/历史证据的ADR、1份待确认决策汇总。
- [reference](reference/README.md)：API/23平台表自动参考、13工具/类型、配置及生成器。
- [VALIDATION](VALIDATION.md)与[verify.py](verify.py)：本次检查说明及可重复只读检查。

## 下一步维护计划

本次五阶段静态文档任务已完成。后续功能迭代先核对领域源码，再更新对应设计/指南；Controller或DDL变化运行reference生成器，并运行verify。运行待确认事项由维护者按需要单独授权验收，不能把它们伪装成本次已验证。

根README现有失效链接本次未修改；维护者后续可将其文档入口改到docs/README.md。本次不在docs内创建旧结构别名以掩盖失效。

## 核心模块增量记录（以下计划为当时记录，均已完成）

- Agent/SQL/状态/Memory/Schema 主实现已深入阅读；五篇 design 已落盘。已确认：查询证据和图表均由程序持久化；分析条件不是 SQL 自动编译器；明确记忆保存与候选确认具有不同生命周期。
- 下一步：补全前后端设计、数据库实体及实现指南；核对事件 Relay、历史恢复与账号链路。

- 第二批完成：前端/API与数据模型设计；Agent、Generation生命周期和SQL/Artifact指南。事件生产/Relay/数据库sequence与前端恢复已追踪，确认raw reasoning不展示、retry为新generation。

- 第三批完成：状态/上下文、Memory、数据源/Schema、前端流式协作、开发环境及调试问题记录。已确认主要调用链与快照/版本/权限边界，未执行业务命令或交互测试。
- 下一步：以当前源码生成API/Schema/配置参考，收集带明确注释的决策证据，然后逐项交叉校验与修文。

- 第四批完成：当前Controller生成API索引，当前DDL生成23表字段参考，提供只读--check；两条ADR有明确注释及对应历史源码证据。生成器核对发现嵌套装饰器误识别上传处理器，已修正并重生成。
- 下一步：统一导航、验证全部文档链接与代码路径、检查Mermaid和敏感内容，重新检查范围保护。

- 第五批完成：完整目录导航、三轮状态/证据示例、可重复只读检查。全部30篇Markdown、321个本地链接、81个源码/配置路径及9幅Mermaid基础结构检查通过；自动API/DDL参考一致，未发现常见真实凭据模式。docs外86项已有变更内容/状态哈希一致，11个旧docs删除保留。未运行Mermaid官方渲染器与浏览器验收。

- 收口核对：42个关键源码符号存在；参考--check与verify重复通过，无尾随空白。业务源码/配置保持基线，交付文件共30篇Markdown及2个文档生成/检查脚本。


## 第二轮：开发者讲解深化（已完成）

用户复核指出第一版核心指南偏概览、数据库关键字段解释不足。本轮保留目录结构，重新按开发者可推演业务的标准深化；第一版“已完成”表示其当时静态覆盖与链接检查，不表示讲解深度已达到最终要求。

| 工作域 | 本轮内容 | 状态 |
| --- | --- | --- |
| Agent / Generation / Context | 模型输入、工具碎片、观察/交付/收尾变量、幂等/writer/取消、追问与预算实例 | 已完成并交叉审读 |
| SQL / Artifact / Frontend | 允许/拒绝规则推演、同份结果对象变化、首次提交与10→12事件/快照恢复 | 已完成并交叉审读 |
| 数据库 / Memory | 23表关键字段语义、读写/生命周期、JSON结构、统一持久化案例与双版本确认 | 已完成并交叉审读 |
| 数据源 / Schema / 开发与排查 | 上传文件到prepared/表目录、权限、注释审核、账号会话、五类故障定位 | 已完成并交叉审读 |
| 导航与交叉验证 | 阅读问题映射、真实代码证据、JSON/图结构、自动参考及范围保护 | 已完成，详见VALIDATION第二轮记录 |

本轮继续只写docs，不连接数据库/模型/SMTP，不运行交互/E2E；教学数据明确与真实运行记录分开。关键字段定义集中在design/data-model，完整列参考继续自动生成，指南解释读写与业务过程。

### 第二轮已确认与修正

- 现有9篇指南均完成深化，新增[数据库持久化指南](guides/database-persistence.md)；[数据模型](design/data-model.md)解释23表重要字段、读写方、用途和生命周期，不复制自动类型字典。
- 补清Loop observed与Adapter observed、answered/delivered、图表须前批观察、prepared门槛和finish的状态修复。
- 补清内容hash不等访问指纹、expectedShape不强制校验、grain只做文本验证、模型行截断与数据库限行不同、图表恢复需要chartData。
- 补清候选自身与目标Memory两套版本、定向候选省略目标仍回退原目标、明确直存在本轮快照前可进入目录、候选确认不重算旧结果。
- 同步记录取消轮询前writer拒绝可能failed的源码推断；未知generation首帧跳号的恢复边界；死信可能造成序号缺口；全部Worker停机不会自己执行超时回收。
- 交叉审读修正了get_schema示例字段名、activity状态枚举、不同原表头清洗碰撞的真实入口、图表块数据、省略字段的语义与outcome不自动清空openQuestions。
- 当前文档共31篇Markdown、2个生成/检查脚本；示例JSON和Mermaid保守结构检查通过，代码与运行待确认分开。docs外86项原变更状态/内容与本轮开始时一致，未恢复旧文档。详细数值以本轮最终verify输出及VALIDATION为准。

### 后续维护

本轮深化工作无待完成核心文档。后续变更按功能链路更新相应指南与关键字段解释，运行参考--check和verify；交互/E2E、真实环境可靠性和产品政策仍按用户另行要求验证，不作为本轮完成依据。

## 第三轮：参考资料业务含义复核（已完成）

用户指出API索引只有路由与处理器，无法理解每个方法的实际作用。本轮已重新检查工作区，只修改docs并保留已有业务变更及旧文档删除。

- 已确认：46接口缺少逐项用途；13工具清单偏重参数/约束而缺调用场景；平台表参考缺逐表用途与关键字段解释定位。配置参考已有用途，继续核对生效范围与易误解默认值。
- 已完成：46接口逐项中文用途、主要结果与关键权限/状态边界，按业务领域分组；sync、SSE、单任务补洞、取消/重试、注释建议/保存、Memory/候选的区别均已源码核对。
- 已完成：23表用途及关键字段设计章节入口；13工具补具体作用与调用时机，共享类型补关键字段语义和消费者；配置补API/Worker生效范围，并纠正SMTP_FROM/PORT空字符串默认值边界。
- 已完成：独立审读design/guides/decisions与导航，现有职责、关系、字段语义与业务分支说明已具备本轮所检查的用途信息。字段详解继续单一维护在data-model，持久化过程在相应guide。
- 已完成：生成器合并人工核对的用途注释与源码定义；新增/删除入口若缺说明或有残留、证据路径或符号失效，均拒绝生成；现有符号未变的内部行为仍必须人工核对。
- 已完成：参考导航与维护方式更新，JSON用途记录、覆盖集合、标题锚点、链接、结构及写入边界检查通过，最终记录见VALIDATION第三轮。

### 本轮交叉审读修正

- related接口是文本相似项提示，供人工核对，不能描述为自动语义冲突检测。
- 上传限制来自is_local标记；候选确认仅在有正式Memory替换目标时检查目标版本。
- Artifact访问指纹包含授权目录表集合和字段策略，数据源标记统一称默认本地源。
- 配置读取符号核对到AuthService.requestReset；QueryArtifactResultV1以artifact和rows两层包装返回。

本轮交付仍为31篇Markdown及2个生成/检查脚本，新增2份用途注释JSON，全部位于docs。docs外86项原变更状态与内容哈希保持一致；没有未完成的本轮核心文档项。后续改接口/表时同步注释文件并重生成，按维护流程继续核对语义及快速文档检查。
