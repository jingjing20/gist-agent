# API 接口索引（路由生成与用途说明）

用途：按业务目的选择接口，理解每个方法的主要结果，再定位真实处理器与实现指南。适用读者：前端、API开发。分析基线：2026-10-14当前工作区。

来源：方法、路径和处理器从Nest Controller/HTTP装饰器提取；中文用途由[api-descriptions.json](api-descriptions.json)依据处理器及服务人工核对后维护，生成器合并两者，不根据方法名推测功能。API全局前缀`/api`，默认全局JWT Guard；Worker health使用独立端口。

重新生成：`python3 docs/reference/generate.py`；只读校验：`python3 docs/reference/generate.py --check`。新增/删除路由必须同步用途说明；缺失或多余条目、无效证据路径/符号会阻止生成和检查。已有路由内部行为变化仍需人工复核用途，不能以生成一致代替语义校验。

这不是OpenAPI或线上接口探测，不推断默认HTTP响应码、完整body类型或统一错误包装。下方鉴权列说明入口是否要求JWT；数据所有权/源共享/版本等进一步限制见用途、关键边界及链接指南。

## 认证与账号

| 方法 | 路径 | 作用与主要结果 | 鉴权入口 | 处理器与代码依据 | 详解 |
| --- | --- | --- | --- | --- | --- |
| POST | `/api/auth/register` | 注册邮箱账号，保存密码哈希并返回用户资料与登录 JWT；邮箱按小写和首尾空白归一化，同邮箱不能重复注册。 | 公开 | [`AuthController.register`](../../apps/api/src/auth/auth.controller.ts)；[`AuthService.register`](../../apps/api/src/auth/auth.service.ts)；[`register`](../../apps/web/src/stores/auth.ts) | [实现指南](../guides/development.md) |
| POST | `/api/auth/login` | 校验邮箱和密码，返回用户资料与登录 JWT；JWT 包含凭据版本，后续请求会检查密码是否已变更。 | 公开 | [`AuthController.login`](../../apps/api/src/auth/auth.controller.ts)；[`AuthService.login`](../../apps/api/src/auth/auth.service.ts)；[`AuthService.findById`](../../apps/api/src/auth/auth.service.ts) | [实现指南](../guides/development.md) |
| POST | `/api/auth/forgot-password` | 为已注册邮箱创建限时密码重置凭据并发送重置邮件；未注册邮箱也返回通用提示，实际邮件发送失败仍可能导致请求报错。 | 公开 | [`AuthController.forgotPassword`](../../apps/api/src/auth/auth.controller.ts)；[`AuthService.requestReset`](../../apps/api/src/auth/auth.service.ts)；[`handleSubmit`](../../apps/web/src/views/ForgotPasswordPage.vue) | [实现指南](../guides/development.md) |
| POST | `/api/auth/reset-password` | 使用未过期、未使用的邮件重置凭据设置新密码，并将该用户尚未使用的重置凭据一并作废；旧登录 JWT 随密码凭据版本变化而失效。 | 公开 | [`AuthController.resetPassword`](../../apps/api/src/auth/auth.controller.ts)；[`AuthService.resetPassword`](../../apps/api/src/auth/auth.service.ts)；[`AuthService.findById`](../../apps/api/src/auth/auth.service.ts) | [实现指南](../guides/development.md) |
| POST | `/api/auth/me` | 读取经过 JWT 和当前凭据版本校验的登录用户资料，供页面刷新时恢复账号状态；此接口不签发或刷新 Token。 | Bearer JWT | [`AuthController.me`](../../apps/api/src/auth/auth.controller.ts)；[`AuthService.findById`](../../apps/api/src/auth/auth.service.ts)；[`fetchUser`](../../apps/web/src/stores/auth.ts) | [实现指南](../guides/development.md) |
| GET | `/api/users/search` | 按邮箱片段查找用户 ID、邮箱和名称，供数据源授权时选择目标用户；搜索内容不足两个字符时返回空数组，最多返回 20 人。 | Bearer JWT | [`UserController.search`](../../apps/api/src/user/user.controller.ts)；[`UserService.searchByEmail`](../../apps/api/src/user/user.service.ts)；[`debouncedSearch`](../../apps/web/src/views/DataSourceView.vue) | [实现指南](../guides/development.md) |
| PUT | `/api/users/profile` | 修改当前登录用户的展示名称；只更新本人资料，不修改邮箱、密码或其他用户。 | Bearer JWT | [`UserController.updateProfile`](../../apps/api/src/user/user.controller.ts)；[`UserService.updateProfile`](../../apps/api/src/user/user.service.ts)；[`updateProfile`](../../apps/web/src/stores/auth.ts) | [实现指南](../guides/development.md) |
| PUT | `/api/users/password` | 校验当前密码后为登录用户设置新密码，并作废其未使用的重置凭据；密码更新后凭据版本改变，旧登录 JWT 无法继续通过校验。 | Bearer JWT | [`UserController.updatePassword`](../../apps/api/src/user/user.controller.ts)；[`UserService.updatePassword`](../../apps/api/src/user/user.service.ts)；[`AuthService.findById`](../../apps/api/src/auth/auth.service.ts) | [实现指南](../guides/development.md) |

## 会话与历史消息

| 方法 | 路径 | 作用与主要结果 | 鉴权入口 | 处理器与代码依据 | 详解 |
| --- | --- | --- | --- | --- | --- |
| GET | `/api/conversations` | 列出当前用户的会话，按最近更新时间倒序返回标题、数据源关联等信息，供侧边栏切换历史分析。 | Bearer JWT | [`ConversationController.findAll`](../../apps/api/src/conversation/conversation.controller.ts)；[`ConversationService.findAll`](../../apps/api/src/conversation/conversation.service.ts)；[`fetchConversations`](../../apps/web/src/stores/chat.ts) | [实现指南](../guides/frontend-streaming.md) |
| POST | `/api/conversations` | 创建属于当前用户的空会话并返回会话记录，供首次提交问题前获取 conversationId；创建会话本身不触发 Agent 执行。 | Bearer JWT | [`ConversationController.create`](../../apps/api/src/conversation/conversation.controller.ts)；[`ConversationService.create`](../../apps/api/src/conversation/conversation.service.ts)；[`createConversation`](../../apps/web/src/stores/chat.ts) | [实现指南](../guides/frontend-streaming.md) |
| DELETE | `/api/conversations/:id` | 删除本人会话，在事务中清理关联 Generation 的 Outbox，并由外键级联删除消息与相关执行记录；正式 Memory 的历史来源标识独立保留。 | Bearer JWT | [`ConversationController.remove`](../../apps/api/src/conversation/conversation.controller.ts)；[`ConversationService.remove`](../../apps/api/src/conversation/conversation.service.ts)；[`DATASOURCE_MEMORY_SCHEMA_SQL`](../../packages/database/src/memory-schema.ts) | [实现指南](../guides/database-persistence.md) |
| GET | `/api/conversations/:id/messages` | 读取本人会话按时间排序的持久化消息，以及助手消息对应的 Generation 状态和最后序号，恢复历史文本、表格、图表与执行过程；会话不存在或不属于本人时返回空数组。 | Bearer JWT | [`ConversationController.getMessages`](../../apps/api/src/conversation/conversation.controller.ts)；[`ConversationService.getMessages`](../../apps/api/src/conversation/conversation.service.ts)；[`fetchMessages`](../../apps/web/src/stores/chat.ts) | [实现指南](../guides/frontend-streaming.md) |

## 分析任务与流式通信

| 方法 | 路径 | 作用与主要结果 | 鉴权入口 | 处理器与代码依据 | 详解 |
| --- | --- | --- | --- | --- | --- |
| POST | `/api/chat` | 提交会话中的用户问题，原子创建用户消息、助手占位消息、Generation、Turn 和入队 Outbox，返回四个标识；实际 Agent 分析由独立 Worker 异步执行，并受幂等键、会话活动任务和用户并发限制约束。 | Bearer JWT | [`ChatController.chat`](../../apps/api/src/chat/chat.controller.ts)；[`ChatService.startChat`](../../apps/api/src/chat/chat.service.ts)；[`GenerationService.createTurn`](../../apps/api/src/chat/generation.service.ts) | [实现指南](../guides/generation-lifecycle.md) |
| GET | `/api/chat/sync` | 恢复实时订阅前取得用户 Redis 事件游标、所有活动 Generation 快照，以及客户端已知 Generation 的状态快照；用于对齐任务状态，和单任务事件补洞接口分工不同。 | Bearer JWT | [`ChatController.sync`](../../apps/api/src/chat/chat.controller.ts)；[`GenerationService.sync`](../../apps/api/src/chat/generation.service.ts)；[`startRealtime`](../../apps/web/src/stores/chat.ts) | [实现指南](../guides/frontend-streaming.md) |
| GET | `/api/chat/events` | 从给定 Redis Stream 游标持续订阅当前用户各会话的实时 SSE 事件，包含增量文本、工具过程和任务结束通知；连接空闲时发送心跳，Generation 逻辑序号缺口另由历史接口补齐。 | Bearer JWT | [`ChatController.stream`](../../apps/api/src/chat/chat.controller.ts)；[`GenerationService.stream`](../../apps/api/src/chat/generation.service.ts)；[`startRealtime`](../../apps/web/src/stores/chat.ts) | [实现指南](../guides/frontend-streaming.md) |
| GET | `/api/chat/generations/:id/events` | 按 Generation 逻辑序号读取 PostgreSQL 中持久化的后续事件，用于客户端发现事件缺口后的补洞；事件不连续或缺少所需终态事件时返回消息与任务状态快照。 | Bearer JWT | [`ChatController.history`](../../apps/api/src/chat/chat.controller.ts)；[`GenerationService.history`](../../apps/api/src/chat/generation.service.ts)；[`resync`](../../apps/web/src/stores/chat.ts) | [实现指南](../guides/frontend-streaming.md) |
| POST | `/api/chat/generations/:id/cancel` | 将本人活动 Generation 标记为 cancel_requested，交由 Worker 轮询后中断执行并落定终态；接口返回时不代表模型、SQL 或任务已同步停止。 | Bearer JWT | [`ChatController.cancel`](../../apps/api/src/chat/chat.controller.ts)；[`GenerationService.cancel`](../../apps/api/src/chat/generation.service.ts)；[`cancelGeneration`](../../apps/web/src/stores/chat.ts) | [实现指南](../guides/generation-lifecycle.md) |
| POST | `/api/chat/generations/:id/retry` | 读取本人 failed 或 cancelled Generation 的原问题、会话、数据源和推理开关，重新提交为新的 Generation 和消息；重新执行整个任务，不从旧检查点续跑。 | Bearer JWT | [`ChatController.retry`](../../apps/api/src/chat/chat.controller.ts)；[`GenerationService.retry`](../../apps/api/src/chat/generation.service.ts)；[`ChatService.startChat`](../../apps/api/src/chat/chat.service.ts) | [实现指南](../guides/generation-lifecycle.md) |

## 分析证据

| 方法 | 路径 | 作用与主要结果 | 鉴权入口 | 处理器与代码依据 | 详解 |
| --- | --- | --- | --- | --- | --- |
| GET | `/api/analysis-artifacts/:id` | 查看一次分析查询的证据说明，包括查询目的、原始与执行 SQL、列定义、行数、分析上下文和质量标记；同时核验会话归属、数据源访问权、有效期及当前目录与字段权限指纹。 | Bearer JWT | [`AnalysisArtifactController.metadata`](../../apps/api/src/analysis-artifact/analysis-artifact.module.ts)；[`AnalysisArtifactController.read`](../../apps/api/src/analysis-artifact/analysis-artifact.module.ts)；[`load`](../../apps/web/src/components/blocks/QueryEvidence.vue) | [实现指南](../guides/sql-and-artifacts.md) |
| GET | `/api/analysis-artifacts/:id/rows` | 按存储行偏移量分页读取查询证据中已保存、已脱敏的结果行，供表格展开和加载更多使用；不会重新执行 SQL，权限与有效期检查和证据元数据接口相同。 | Bearer JWT | [`AnalysisArtifactController.rows`](../../apps/api/src/analysis-artifact/analysis-artifact.module.ts)；[`AnalysisArtifactController.read`](../../apps/api/src/analysis-artifact/analysis-artifact.module.ts)；[`load`](../../apps/web/src/components/blocks/AnalysisArtifactTable.vue) | [实现指南](../guides/sql-and-artifacts.md) |

## 数据源与表管理

| 方法 | 路径 | 作用与主要结果 | 鉴权入口 | 处理器与代码依据 | 详解 |
| --- | --- | --- | --- | --- | --- |
| GET | `/api/datasources` | 列出当前用户可访问的公共、自建及被授权数据源，供分析输入和数据源管理页选择；数据源是平台表目录的归属空间。 | Bearer JWT | [`DataSourceController.findAll`](../../apps/api/src/datasource/datasource.controller.ts)；[`DataSourceService.findAllForUser`](../../apps/api/src/datasource/datasource.service.ts)；[`fetchAll`](../../apps/web/src/stores/datasource.ts) | [实现指南](../guides/datasource-and-schema.md) |
| GET | `/api/datasources/:id/tables` | 读取可访问数据源中登记的表目录及展示名称、来源、上传者和 Agent 可见标记，用于管理表；这份目录包含 Agent 不可见的登记表，与 schema 接口的可见结构结果不同。 | Bearer JWT | [`DataSourceController.listTables`](../../apps/api/src/datasource/datasource.controller.ts)；[`DataSourceService.listTables`](../../apps/api/src/datasource/datasource.service.ts)；[`listTables`](../../apps/web/src/stores/datasource.ts) | [实现指南](../guides/datasource-and-schema.md) |
| POST | `/api/datasources/:id/tables` | 将 CSV 或 Excel 中选定的表清洗后导入平台 PostgreSQL，在一个事务中创建物理表、插入行、写入初始注释并登记表目录；需要数据源访问权，默认本地数据源（is_local=1）禁止上传。 | Bearer JWT | [`DataSourceController.uploadTable`](../../apps/api/src/datasource/datasource.controller.ts)；[`DataSourceService.uploadTables`](../../apps/api/src/datasource/datasource.service.ts)；[`DataSourceService.uploadTable`](../../apps/api/src/datasource/datasource.service.ts) | [实现指南](../guides/datasource-and-schema.md) |
| DELETE | `/api/datasources/:id/tables/:tableId` | 删除指定用户上传表的物理表、目录和列策略，清理 Schema 与推荐问题缓存；只允许仍可访问数据源的表上传人或数据源创建者操作，预置及 external 目录表不可通过此接口删除。 | Bearer JWT | [`DataSourceController.deleteTable`](../../apps/api/src/datasource/datasource.controller.ts)；[`DataSourceService.deleteTable`](../../apps/api/src/datasource/datasource.service.ts)；[`deleteTable`](../../apps/web/src/stores/datasource.ts) | [实现指南](../guides/datasource-and-schema.md) |
| GET | `/api/datasources/:id` | 核验用户对数据源的访问权并返回其名称、描述、默认本地源标记和创建者等信息；不返回远程数据库连接参数。 | Bearer JWT | [`DataSourceController.findOne`](../../apps/api/src/datasource/datasource.controller.ts)；[`DataSourceService.findOne`](../../apps/api/src/datasource/datasource.service.ts)；[`DataSourceService.canAccess`](../../apps/api/src/datasource/datasource.service.ts) | [实现指南](../guides/datasource-and-schema.md) |
| POST | `/api/datasources` | 创建当前用户拥有的数据源名称与描述记录，并登记创建者的访问权限；不建立远程数据库连接，也不自动创建分析数据表。 | Bearer JWT | [`DataSourceController.create`](../../apps/api/src/datasource/datasource.controller.ts)；[`DataSourceService.create`](../../apps/api/src/datasource/datasource.service.ts)；[`create`](../../apps/web/src/stores/datasource.ts) | [实现指南](../guides/datasource-and-schema.md) |
| PATCH | `/api/datasources/:id` | 由数据源创建者修改名称和描述并返回更新后的数据源信息；更新不修改物理表、表目录或数据库连接。 | Bearer JWT | [`DataSourceController.update`](../../apps/api/src/datasource/datasource.controller.ts)；[`DataSourceService.update`](../../apps/api/src/datasource/datasource.service.ts)；[`update`](../../apps/web/src/stores/datasource.ts) | [实现指南](../guides/datasource-and-schema.md) |
| DELETE | `/api/datasources/:id` | 由创建者删除非默认数据源，在事务内删除其 uploaded 物理表及数据源记录，并级联清理依附实体；默认本地数据源禁止删除。 | Bearer JWT | [`DataSourceController.remove`](../../apps/api/src/datasource/datasource.controller.ts)；[`DataSourceService.remove`](../../apps/api/src/datasource/datasource.service.ts)；[`remove`](../../apps/web/src/stores/datasource.ts) | [实现指南](../guides/database-persistence.md) |

## 数据源授权

| 方法 | 路径 | 作用与主要结果 | 鉴权入口 | 处理器与代码依据 | 详解 |
| --- | --- | --- | --- | --- | --- |
| POST | `/api/datasources/:id/grant` | 由数据源创建者为指定用户登记访问授权，重复授权不新增重复记录；授权提供数据源访问能力，不把对方变为创建者或赋予正式 Memory 写权限。 | Bearer JWT | [`DataSourceController.grant`](../../apps/api/src/datasource/datasource.controller.ts)；[`DataSourceService.grant`](../../apps/api/src/datasource/datasource.service.ts)；[`MemoryRepository.authorize`](../../packages/database/src/memory-repository.ts) | [实现指南](../guides/datasource-and-schema.md) |
| POST | `/api/datasources/:id/revoke` | 由数据源创建者移除指定用户的显式访问授权；公共数据源可见性和创建者身份本身的访问权不由该授权记录决定。 | Bearer JWT | [`DataSourceController.revoke`](../../apps/api/src/datasource/datasource.controller.ts)；[`DataSourceService.revoke`](../../apps/api/src/datasource/datasource.service.ts)；[`DataSourceService.canAccess`](../../apps/api/src/datasource/datasource.service.ts) | [实现指南](../guides/datasource-and-schema.md) |
| GET | `/api/datasources/:id/permissions` | 由数据源创建者查看显式授权用户的 ID、邮箱和名称，供授权管理弹窗选择撤销对象；这是权限记录列表，不是所有可见用户的枚举。 | Bearer JWT | [`DataSourceController.listPermissions`](../../apps/api/src/datasource/datasource.controller.ts)；[`DataSourceService.listPermissionUsers`](../../apps/api/src/datasource/datasource.service.ts)；[`listPermissions`](../../apps/web/src/stores/datasource.ts) | [实现指南](../guides/datasource-and-schema.md) |

## Schema 与业务语义

| 方法 | 路径 | 作用与主要结果 | 鉴权入口 | 处理器与代码依据 | 详解 |
| --- | --- | --- | --- | --- | --- |
| GET | `/api/datasources/:id/tables/:tableId/column-comments` | 读取目标物理表当前字段名称、类型和正式 PostgreSQL 注释，作为注释审核的原始基线；仅允许仍可访问该数据源的创建者或表上传人使用。 | Bearer JWT | [`DataSourceController.columnComments`](../../apps/api/src/datasource/datasource.controller.ts)；[`SchemaEnrichmentService.inspect`](../../apps/api/src/datasource/schema-enrichment.service.ts)；[`refreshOriginals`](../../apps/web/src/components/datasource/SchemaEnrichmentModal.vue) | [实现指南](../guides/datasource-and-schema.md) |
| POST | `/api/datasources/:id/tables/:tableId/column-comments/suggestions` | 基于所选字段的原注释和受限样本调用模型，生成待审核的字段业务说明、依据和待核实项；受限制字段值不发送给模型，此步骤不写入正式注释。 | Bearer JWT | [`DataSourceController.generateColumnComments`](../../apps/api/src/datasource/datasource.controller.ts)；[`SchemaEnrichmentService.generate`](../../apps/api/src/datasource/schema-enrichment.service.ts)；[`generate`](../../apps/web/src/components/datasource/SchemaEnrichmentModal.vue) | [实现指南](../guides/datasource-and-schema.md) |
| PATCH | `/api/datasources/:id/tables/:tableId/column-comments` | 将用户审核后的字段说明批量写入 PostgreSQL 正式列注释，并清理 Schema 与推荐问题缓存；逐项核对 originalComment，原注释已被他人修改时整批拒绝保存。 | Bearer JWT | [`DataSourceController.saveColumnComments`](../../apps/api/src/datasource/datasource.controller.ts)；[`SchemaEnrichmentService.save`](../../apps/api/src/datasource/schema-enrichment.service.ts)；[`save`](../../apps/web/src/components/datasource/SchemaEnrichmentModal.vue) | [实现指南](../guides/datasource-and-schema.md) |
| GET | `/api/datasources/:id/suggestions` | 根据当前可见 Schema 和请求语言读取或生成首页推荐分析问题；缓存按用户、Schema 哈希与 Prompt 版本区分，不读取业务行或正式 Memory 来生成这些问题。 | Bearer JWT | [`DataSourceController.getSuggestions`](../../apps/api/src/datasource/datasource.controller.ts)；[`SuggestionService.getSuggestions`](../../apps/api/src/datasource/suggestion.service.ts)；[`fetchSuggestions`](../../apps/web/src/stores/datasource.ts) | [实现指南](../guides/datasource-and-schema.md) |
| GET | `/api/datasources/:id/schema` | 读取当前用户可访问且对 Agent 开放的表结构，返回展示名、字段类型、正式注释与脱敏标记；deny 字段被过滤，用于前端结构浏览和分析语义理解。 | Bearer JWT | [`DataSourceController.getSchema`](../../apps/api/src/datasource/datasource.controller.ts)；[`SchemaService.getStructuredSchema`](../../apps/api/src/database/schema.service.ts)；[`fetchSchema`](../../apps/web/src/stores/datasource.ts) | [实现指南](../guides/datasource-and-schema.md) |

## 正式业务记忆

| 方法 | 路径 | 作用与主要结果 | 鉴权入口 | 处理器与代码依据 | 详解 |
| --- | --- | --- | --- | --- | --- |
| GET | `/api/memories` | 按数据源分页读取当前有效正式 Memory 的最新版本，可按名称和说明文本搜索；可访问数据源的用户可读，不包含已删除记忆或待审核候选。 | Bearer JWT | [`MemoryController.list`](../../apps/api/src/memory/memory.module.ts)；[`MemoryRepository.list`](../../packages/database/src/memory-repository.ts)；[`load`](../../apps/web/src/views/MemoriesView.vue) | [实现指南](../guides/memory.md) |
| GET | `/api/memories/:id` | 读取一条正式 Memory 的当前版本或指定历史版本，供编辑前核对与历史追溯；当前已软删除时仍可在有访问权的前提下读取历史内容，但状态标记为 deleted。 | Bearer JWT | [`MemoryController.get`](../../apps/api/src/memory/memory.module.ts)；[`MemoryRepository.get`](../../packages/database/src/memory-repository.ts)；[`readHistory`](../../apps/web/src/views/MemoriesView.vue) | [实现指南](../guides/memory.md) |
| POST | `/api/memories/related` | 将准备保存的名称和说明与当前有效正式 Memory 做同名及文本相似度匹配，返回相关项供人工核对潜在重复或口径冲突；不判断语义矛盾，也不写入或自动合并记忆。 | Bearer JWT | [`MemoryController.related`](../../apps/api/src/memory/memory.module.ts)；[`MemoryRepository.related`](../../packages/database/src/memory-repository.ts)；[`relatedMemories`](../../packages/database/src/memory-policy.ts) | [实现指南](../guides/memory.md) |
| POST | `/api/memories` | 由数据源创建者直接创建一条正式业务记忆，保存名称、说明和首个不可变修订；同数据源内有效记忆的归一化名称必须唯一。 | Bearer JWT | [`MemoryController.create`](../../apps/api/src/memory/memory.module.ts)；[`MemoryRepository.create`](../../packages/database/src/memory-repository.ts)；[`MemoryRepository.save`](../../packages/database/src/memory-repository.ts) | [实现指南](../guides/memory.md) |
| PATCH | `/api/memories/:id` | 由数据源创建者修改正式 Memory 的名称或说明，核对 expectedVersion 后追加新修订并推进当前版本；保留旧版本，版本已变化时拒绝覆盖。 | Bearer JWT | [`MemoryController.update`](../../apps/api/src/memory/memory.module.ts)；[`MemoryRepository.update`](../../packages/database/src/memory-repository.ts)；[`MemoryRepository.save`](../../packages/database/src/memory-repository.ts) | [实现指南](../guides/memory.md) |
| DELETE | `/api/memories/:id` | 由数据源创建者核对 expectedVersion 后软删除正式 Memory，并追加删除修订；后续有效记忆列表和新分析快照排除它，历史修订仍保留。 | Bearer JWT | [`MemoryController.remove`](../../apps/api/src/memory/memory.module.ts)；[`MemoryRepository.update`](../../packages/database/src/memory-repository.ts)；[`MemoryRepository.save`](../../packages/database/src/memory-repository.ts) | [实现指南](../guides/memory.md) |

## 记忆候选审核

| 方法 | 路径 | 作用与主要结果 | 鉴权入口 | 处理器与代码依据 | 详解 |
| --- | --- | --- | --- | --- | --- |
| GET | `/api/memory-candidates` | 由数据源创建者查看本人待审核的 Memory 候选，可限定来源会话；仅展示所属 Generation 已 completed 的候选，候选本身尚未进入正式 Memory。 | Bearer JWT | [`CandidateController.list`](../../apps/api/src/memory/memory.module.ts)；[`MemoryRepository.candidates`](../../packages/database/src/memory-repository.ts)；[`loadCandidates`](../../apps/web/src/components/blocks/AnalysisBlock.vue) | [实现指南](../guides/memory.md) |
| POST | `/api/memory-candidates/:id/confirm` | 由数据源创建者确认 completed Generation 的候选，可先修改内容，再创建正式 Memory 或更新目标 Memory；事务核对候选版本，有替换目标时再核对目标记忆版本，保存修订并将候选标记为 accepted。 | Bearer JWT | [`CandidateController.confirm`](../../apps/api/src/memory/memory.module.ts)；[`MemoryRepository.decide`](../../packages/database/src/memory-repository.ts)；[`save`](../../apps/web/src/components/MemoryEditor.vue) | [实现指南](../guides/memory.md) |
| POST | `/api/memory-candidates/:id/reject` | 由数据源创建者核对候选版本后放弃 completed Generation 的候选，将状态改为 rejected 并推进候选版本；不会创建、更新或删除正式 Memory。 | Bearer JWT | [`CandidateController.reject`](../../apps/api/src/memory/memory.module.ts)；[`MemoryRepository.decide`](../../packages/database/src/memory-repository.ts)；[`decide`](../../apps/web/src/views/MemoriesView.vue) | [实现指南](../guides/memory.md) |

## Worker 运维

| 方法 | 路径 | 作用与主要结果 | 鉴权入口 | 处理器与代码依据 | 详解 |
| --- | --- | --- | --- | --- | --- |
| GET | `/health` | 在 Worker 自身 HTTP 端口返回固定的进程存活响应；不检查 PostgreSQL、Redis、模型或队列是否可用，也不代表执行系统已就绪。 | Worker 进程端口，无 JWT | [`HealthController.health`](../../apps/worker/src/health.controller.ts)；[`HealthController.health`](../../apps/worker/src/health.controller.ts) | [实现指南](../guides/development.md) |

共 46 个接口（含独立Worker health），每个接口均有经源码核对的用途说明。


## 关键请求和响应边界

- `POST /api/chat`：body为message、conversationId、可选datasourceId/reasoningEnabled；header Idempotency-Key；202返回generationId/conversationId/userMessageId/responseMessageId。取消/重试的id是generation ID。
- `GET /api/chat/sync`：query `known_generation_ids`逗号分隔最多100项；返回eventCursor、activeGenerations、reconciledGenerations。
- `GET /api/chat/events`：query `after`为RedisStream ID，返回SSE；history query `after_sequence`为generation逻辑序号，返回mode=events或snapshot。
- Artifact元数据和rows都要求query conversationId；rows可带cursor/limit（默认50，1–100），nextCursor是存储行偏移量。
- 上传tables：multipart `file`与`tableConfigs`，后者是`[{sheetName?,displayName}]`的JSON字符串。数据源create/update仅name/description，没有远程数据库host/password字段。
- 列注释建议body为columns字符串数组；保存body为changes（column/originalComment/comment）。
- Memory list：query datasourceId、q、cursor、limit；get可带version；create body datasourceId/name/description；patch body expectedVersion和name/description；delete query expectedVersion。
- Memory related：body datasourceId/content、可选excludeId；候选list query datasourceId、可选conversationId；confirm body expectedVersion，可选content/memoryId/expectedMemoryVersion；reject只有expectedVersion。
- 用户改密码body包含currentPassword/password；找回密码body email、可选origin；重置body token/password；认证me为POST。

Controller inline TypeScript类型不等于完整运行时校验；实际约束必须继续阅读对应Service。核心链路见 [Generation指南](../guides/generation-lifecycle.md) 和 [Memory指南](../guides/memory.md)。
