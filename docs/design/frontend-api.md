# 前端与 API 设计

用途：解释页面、客户端状态和服务端边界。适用读者：前端、API 和全栈开发。

## 前端模块

Vue Router 使用 history 模式，公共页为登录、注册、忘记密码、重置密码；受保护区域为 `/chat`、`/chat/:convId`、`/datasource`、`/memories`。`MainLayout` 提供导航、用户信息、密码修改和主题切换。

| 模块 | 职责 | 证据 |
| --- | --- | --- |
| auth Store | localStorage JWT、当前用户、账号请求、登出清空其他 Store | [auth.ts](../../apps/web/src/stores/auth.ts) |
| datasource Store | 数据源列表、权限、表上传、结构、首页推荐缓存 | [datasource.ts](../../apps/web/src/stores/datasource.ts) |
| chat Store | 多会话消息、活动 generation、SSE、去重、补洞、取消和重试 | [chat.ts](../../apps/web/src/stores/chat.ts) |
| 消息渲染 | 顺序内容块、活动过程、结果、候选及推荐 | [ChatMessageItem](../../apps/web/src/components/ChatMessageItem.vue) |
| 表格/图表 | Artifact 数据分页、依据、放大、ECharts | [ArtifactResult](../../apps/web/src/components/blocks/ArtifactResult.vue) |

API 请求前缀是 `/api`；`apiFetch` 加 Bearer，非 FormData body 默认 JSON；非 auth API 的 401 清除 token 并跳登录。路由保护只影响界面，数据权限仍由 API/Worker检查。

## 结果与过程分离

`AnalysisProcessBlock` 接收结构化 analysis_activity、阶段 log 与 SQL，用作过程详情。正文 text、显式 display table、chart、analysis 元数据和 Memory Notice 按发生顺序展示。

- 原始 reasoning 不进入用户显示；ThinkingBlock 等旧组件/事件兼容类型的存在不证明当前运行时输出思维链。
- MarkdownIt 关闭原始 HTML，前端文字播放与 SSE 到达速度解耦。done 可以先到，文字继续播放；同消息后续结果等待前面文字播放。
- 新结果由流事件追加，历史结果来自 message.blocks；analysis.outcome.blocks 在当前 Adapter 中为空，避免重新播放全文。
- 表格根据 Artifact ID 读取元数据和存储行，最多 100 行一页；图表已有 chartData 存于消息块中，由 ECharts 转 option。
- 查询依据弹窗重新请求 Artifact 元数据，检查当前访问和访问指纹；放大或查看依据时记录阅读位置。
- 推荐仅最新 assistant 消息、generation completed、流和文字播放结束后展示。

更细致的同步和渲染入口见 [前端指南](../guides/frontend-streaming.md)。

## API 边界

API AppModule 注册 Auth、User、Conversation、Chat、DataSource、Memory、AnalysisArtifact 模块；全局 JwtAuthGuard 默认保护路由，`@Public` 只用于四个账号公开接口。没有全局 ValidationPipe，许多请求以 TypeScript inline body 类型描述，运行时校验分布在 Controller/Service，不能将类型当自动验证。

API 创建分析任务返回 202 和标识；`GET chat/events` 是**用户级** SSE，多会话共享连接。历史补齐查询 generation_event；不连续时返回 message 快照。接口索引由 Controller 生成，见 [API 参考](../reference/api-index.md)。

## 认证与权限

密码用 bcrypt（cost 10）；JWT 有效期配置七天，并携带 password_hash 的 SHA-256 版本摘要。JWT Strategy 查数据库校验版本，改密码/重置后旧凭证失效。重置 token 由随机字节生成，数据库只保存摘要；有效期十五分钟且一次使用，成功后使该用户所有未用重置 token 失效。

对话/Artifact 绑定用户；数据源共享按许可；Memory 写权限仅所有者。邮箱搜索受全局 JWT 保护，用于授权用户选择。当前未发现组织、团队 RBAC、刷新 token 或登录限流模块。

依据：[AuthService](../../apps/api/src/auth/auth.service.ts)、[JwtStrategy](../../apps/api/src/auth/jwt.strategy.ts)、[UserService](../../apps/api/src/user/user.service.ts)。账号机制与排查见 [开发指南](../guides/development.md)。
