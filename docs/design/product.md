# 产品概览与功能设计

用途：说明当前用户能做什么及业务约束。适用读者：产品、开发、架构维护者。当前实现快照与证据口径见 [分析进度](../ANALYSIS_PROGRESS.md)。

## 定位与用户

**已确认**：Gist Agent 提供登录后的自然语言数据分析、文件数据导入、数据源授权和业务口径记忆管理。**推断**：主要面向能提出业务问题但不希望手工编写 SQL 的分析使用者，以及负责数据准备与口径维护的数据源所有者；代码没有明确行业、组织规模或商业定位定义。

## 功能地图

| 用户操作 | 前端入口 | API/服务入口 | 主要落点 |
| --- | --- | --- | --- |
| 注册、登录、找回密码 | 登录/注册/重置密码页面 | `AuthController`、`AuthService` | app_user、password_reset_token、SMTP |
| 修改昵称、密码、主题 | `MainLayout.vue`、auth Store | `UserController`；主题为前端状态 | 用户记录、浏览器存储 |
| 创建、浏览、删除会话 | `ChatView.vue`、`ChatSidebar.vue` | `ConversationController` | conversation、message |
| 提问、查看过程、取消、重试 | `ChatInput.vue`、`ChatMessageItem.vue`、chat Store | `ChatController` → API `ChatService` → generation | Worker、LLM、查询证据 |
| 查看表格、图表和查询依据 | `ArtifactResult.vue`、`QueryEvidence.vue` | `AnalysisArtifactController` | query_artifact、message.blocks |
| 创建/编辑/删除数据源 | `DataSourceView.vue`、数据源弹窗 | `DataSourceController`、`DataSourceService` | data_source、目录 |
| 上传 CSV/Excel、删除上传表 | `UploadTableModal.vue`、`TableListModal.vue` | `uploadTable`、`uploadTables`、`deleteTable` | public 物理表及目录 |
| 授予/撤销数据源访问 | `GrantPermissionModal.vue` | grant/revoke、用户邮箱搜索 | datasource_permission |
| 查看结构、生成并审核字段注释 | `DataSourceDrawer.vue`、`SchemaEnrichmentModal.vue` | SchemaService、SchemaEnrichmentService | PostgreSQL 正式列注释 |
| 保存、修改、删除、查看版本记忆 | `MemoriesView.vue`、`MemoryEditor.vue` | MemoryController → MemoryRepository | 正式记忆和 revision |
| 核对模型提出的记忆候选 | `AnalysisBlock.vue`、`MemoryCandidateCard.vue` | CandidateController → decide | 候选确认、正式版本 |
| 首页推荐/回答后推荐问题 | `ChatEmptyState.vue`、`SuggestionBlock.vue` | SuggestionService / generateSuggestions | 缓存或消息 blocks |

前端页面定义：[router](../../apps/web/src/router/index.ts)。以上功能的实现导航见 [指南索引](../guides/README.md)。

## 核心规则

- 会话、消息和 generation 属于用户；同一会话最多一个活动 generation，单用户默认最多五个。可在不同会话并行分析。
- 数据源访问分公共（created_by 为空）、所有者、显式获授权用户。授权用户可以分析；**可访问不等于可修改所有资料**。
- 数据源名称/说明、删除及权限管理仅所有者可操作；默认本地数据源不可删除、不可上传。非默认可访问数据源允许上传；删除上传表与修改字段注释要求数据源所有者或该表上传者。
- 正式记忆是数据源共享知识，写入和候选确认仅数据源所有者；公共源没有普通用户所有者，因此其记忆不可由普通用户写入。
- CSV/XLS/XLSX 文件最多 20 MiB；每个 CSV 或工作表最多 50,000 行。Excel 可选择多个 sheet；上传是数据导入，不是每次查询直接解析文件。
- 输入框“深度思考”最终是否生效取决于服务端提供商控制能力；内部 reasoning 不展示给用户。
- “重试原问题”新建 generation 和消息，不是从失败步骤续跑。断开 SSE 不会取消任务；停止按钮才请求取消。
- 保存候选后后续分析可采用新口径；当前已经完成的结果不会自动重算。“仅本次使用”会拒绝候选并发送新的临时口径消息。

依据：[DataSourceService](../../apps/api/src/datasource/datasource.service.ts)、[MemoryRepository](../../packages/database/src/memory-repository.ts)、[chat Store](../../apps/web/src/stores/chat.ts)、[AnalysisBlock](../../apps/web/src/components/blocks/AnalysisBlock.vue)。

## 已有能力与边界

当前分析工具支持结构发现、只读 SQL、证据复用、六类图表、显式表格展示、状态更新和记忆提议。没有发现独立 Python 执行、文件系统工具、网页检索工具、向量检索服务、多 Agent 协作、定时分析或跨数据源 JOIN 的产品入口。

`source_type=external` 是表目录分类，并不表示已提供外部数据库凭据和连接管理。没有独立指标/维度/术语结构化管理模块；相关业务定义通过列注释、自由文本 Memory 和本轮临时条件表达。上述未发现项是本次源码范围内的结论，不是未来规划。

## 修改入口

新增功能先定位用户操作、路由、Controller，再确认 Worker 工具与共享契约；不要只改 Prompt 就宣称能力已落地。主要链路见 [架构](architecture.md) 与 [Agent 实现](../guides/agent-loop.md)。
