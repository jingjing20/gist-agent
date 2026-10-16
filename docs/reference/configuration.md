# 配置参考

用途：查询实际读取的环境变量、默认值和部署传递范围。适用读者：开发与运维。本页只记录变量名及非敏感默认值，不记录环境真实值。

## 读取入口

主要依据：[config](../../packages/config/src/index.ts)、[LLM](../../packages/llm/src/index.ts)、[模型预算](../../apps/worker/src/chat/model-capabilities.ts)、[API generation](../../apps/api/src/chat/generation.service.ts)、[Worker壳](../../apps/worker/src/chat/chat.service.ts)、[mailer](../../apps/api/src/auth/mailer.service.ts)、[Compose](../../docker-compose.yml)。

容量和监控的实际消费入口：[GenerationWorkerService](../../apps/worker/src/chat/generation-worker.service.ts)、[GenerationReliabilityService](../../apps/worker/src/chat/generation-reliability.service.ts)、[ZombieGenerationMonitorService](../../apps/worker/src/chat/zombie-generation-monitor.service.ts)、[GenerationService.failStale](../../apps/worker/src/chat/generation.service.ts)。共享数据库池由 [DatabaseClient](../../packages/database/src/index.ts) 构建。

`numberEnv`只接受大于0的有限数，否则fallback；API部分配置直接Number(env)||default，Worker/其他调用有另外的上限/校验，不能认为每个数字都有统一校验器。

`loadWorkspaceEnv` 每个进程只加载一次，按当前目录 `.env`、`../../.env` 顺序取第一个存在的文件，不合并两个文件。API 和 Worker 是独立进程，各自读取自己的环境；更改配置后应按读取方重新启动，当前没有配置热更新入口。本页的“读取方”用于区分变量由谁实际消费，Compose 把变量传入某个容器并不代表该容器使用了所有变量。

## 平台和访问

| 变量 | 代码默认/要求 | 作用 | 读取方/生效范围 |
| --- | --- | --- | --- |
| NODE_ENV | production 时加强要求 | 启用生产环境的 Agent 凭据、JWT 最小长度、APP_ORIGIN 校验 | API、Worker、配置函数；各校验在对应函数实际执行时生效 |
| DB_HOST / DB_PORT | 127.0.0.1 / 5432 | 指定平台 PG 的网络目标；Agent 池复用同一 host/port；init 脚本 host 默认 localhost | API、Worker、初始化脚本 |
| DB_USER / DB_NAME | postgres / gist_agent | 指定应用账号和数据库；datasourceId 不会切换这里的数据库 | API、Worker、初始化脚本 |
| DB_PASSWORD | 敏感值不展示 | 应用账号认证；Compose 要求配置 | API、Worker、初始化脚本 |
| DB_POOL_MAX | 10 | 每个应用池的最大连接数，不是所有进程合计，也不是任务并发数 | API、Worker 各自 databaseConfig |
| AGENT_DB_USER / AGENT_DB_PASSWORD | production 必须配置；开发可回退应用凭据 | 让模型生成的查询使用单独账号；初始化按表目录授予 SELECT，不用于平台状态写入 | API/Worker 的 DatabaseClient 构造时均读取并创建 Agent 池，当前只读查询消费入口在 Worker；初始化/上传授权也使用账号名 |
| AGENT_DB_POOL_MAX | 4 | 每个分析专用池的连接上限；任务数量可以多于同时执行 SQL 的连接数 | API/Worker 均读取 agentDatabaseConfig，当前分析查询由 Worker 使用 |
| JWT_SECRET | 必须独立有效，生产至少 32 字符，拒绝代码列出的占位值 | 签发并验证用户登录 Token | API 的认证模块/策略，不由 Worker 验证用户请求 |
| APP_ORIGIN | 开发回退请求 origin 或 localhost:5173；生产必填 | 生成邮件重置链接的公开 Web origin；不配置 API CORS 或服务监听地址 | API 的 AuthService.requestReset |
| SERVER_PORT | 3000 | API HTTP 监听端口；Web 开发代理不自动跟随修改 | API main；Compose 显式固定为 3000 |
| REDIS_URL | redis://127.0.0.1:6379 | 连接队列、用户事件流与容量租约所在的 Redis | API Relay/SSE、Worker 队列/租约，需连接相同 Redis |
| EVENT_KEY_PREFIX | gist-agent | 区分 Redis 用户事件键和容量租约键的命名空间 | API、Worker 必须一致；BullMQ 队列名来自共享契约，未使用此变量作为队列名称前缀 |

## 执行与模型

| 变量 | 当前默认/要求 | 作用 | 读取方/生效范围 |
| --- | --- | --- | --- |
| WORKER_CONCURRENCY | 5 | 单个 Worker 同时处理的 BullMQ 作业数；还受 Redis 三层容量约束 | Worker 的 GenerationWorkerService |
| WORKER_HEALTH_PORT | 3001 | Worker 的 health HTTP 监听端口，不承接前端聊天 API | Worker main；Compose 固定为 3001 |
| GENERATION_GLOBAL_CONCURRENCY | 20 | 共享 Redis 命名空间内的总执行租约上限 | Worker 的 GenerationReliabilityService |
| GENERATION_PROVIDER_CONCURRENCY | 10 | 相同 LLM_PROVIDER 分组的执行租约上限 | Worker 的 GenerationReliabilityService；不按模型名或 BASE_URL 分组 |
| USER_GENERATION_CONCURRENCY_LIMIT | 5 | API 限制用户未结束任务数；Worker 进一步限制该用户正在执行的租约数量，两个时点不同 | API GenerationService 与 Worker；两端应保持一致 |
| GENERATION_HEARTBEAT_INTERVAL_MS | 5000 | 写数据库心跳、续 Redis 租约；僵尸任务监控以至少 1000 ms 的周期检查 | Worker ChatService、ZombieGenerationMonitorService |
| GENERATION_LEASE_TTL_MS | 20000 | Redis 执行租约寿命；数据库失联任务以 2 倍该值作为过期阈值 | Worker 租约服务和僵尸任务监控；不是 SQL 超时 |
| GENERATION_SEMAPHORE_WAIT_MS | 2000 | 等待获得三层执行容量的最长时间；未获得容量则走作业失败/重试 | Worker 的 GenerationReliabilityService.acquire |
| GENERATION_PENDING_TIMEOUT_MS | 600000 | 未被认领任务的最大排队年龄；实际阈值至少为 2 倍租约 TTL | Worker GenerationService.failStale；需要 Worker 监控运行才会判定过期 |
| CHAT_TIMEOUT_MS | 120000；实际夹在 100–120000 ms | 整轮执行的总超时，用同一 signal 中止模型和工具，不是每次模型调用重置 | Worker ChatService，等待容量的阶段在该定时器之前 |
| OPENAI_API_KEY | 敏感值不展示 | 认证 OpenAI 兼容服务 | API 辅助生成和 Worker 分析共用 LlmClient |
| OPENAI_BASE_URL | https://api.openai.com/v1 | 指定 Chat Completions 服务目标 | API、Worker 的 LlmClient；不实现多供应商动态路由 |
| OPENAI_MODEL | gpt-4o | 每个 LlmClient 构造时固定使用的模型；API 也把模型名记录到任务 | API、Worker；预算和上下文记录同样读取此名，应配置一致 |
| LLM_PROVIDER | openai-compatible | 标记任务的提供商，同时构造 Provider 容量分组；不切换 SDK 或根据 BASE_URL 自动识别 | API 记录、Worker 租约获取 |
| LLM_THINKING_CONTROL | auto | deepseek 强制支持 thinking 控制，none 关闭该控制；auto 根据服务地址/模型名识别 DeepSeek | LlmClient 构造时判断，只有 Worker streamWithTools 发送 thinking 参数；用户请求开关也须开启才启用 reasoning |
| LLM_REASONING_EFFORT | 可选字符串 | 支持 thinking 且本轮启用时，附带 reasoning_effort；代码不验证提供商枚举 | Worker 的流式请求，不用于 API 普通 chat 辅助生成 |
| MAX_CONTEXT_TOKENS | 模型模式表：已知 64000/128000，未知 32000 | 覆盖 Agent 上下文窗口预算；按模型名的本地模式表估算，不会查询模型官方能力 | Worker 的 resolveModelCapability/assembleContext；不是请求 max_tokens |
| RESPONSE_RESERVE_TOKENS | 已知模型 8000，未知 4000 | 从上下文预算预留输出空间，和额外 10% 安全量一起扣除 | Worker 的 AnalysisAgent；不是传给模型的输出硬上限 |
| ANALYSIS_TIMEZONE | Asia/Shanghai，必须有效 IANA 时区 | Prompt 说明默认业务时区；不改变 PostgreSQL 会话时区或自动给 SQL 添加日期条件 | Worker buildAnalysisPrompt，每次构建时校验 |
| PROCESS_ROLE | worker 时跳过 API Relay 启动 | 兼容的 Relay 启停条件，不能把 API 进程变成消费任务的 Worker | API OutboxRelay；当前独立 Worker 不含 API Relay |

固定源码限制（不是env）：SQL15秒、外层1000行、Artifact5MiB、context工具行JSON16,000字符、辅助推荐8秒。修改这些先看对应代码和[查询指南](../guides/sql-and-artifacts.md)。

## 邮件和追踪

邮件仅由 API 的 [MailerService](../../apps/api/src/auth/mailer.service.ts) 消费，Worker 不发邮件。

| 变量 | 默认/要求 | 作用与边界 |
| --- | --- | --- |
| SMTP_HOST / SMTP_USER / SMTP_PASS | 三项均非空才初始化 transporter；敏感值不展示 | 邮件服务器、认证账号与密码；缺失不阻止服务启动，但密码重置邮件操作会报错 |
| SMTP_PORT | 仅未设置时为 465 | SMTP 目标端口，使用 `Number(SMTP_PORT ?? 465)`；空字符串不会回退，按 Number 转为 0 |
| SMTP_SECURE | 仅字符串 false 关闭，其余值开启 | 控制 nodemailer 的 secure 选项，不是开启/关闭整个找回密码功能 |
| SMTP_FROM | 未设置时回退 SMTP_USER | 重置邮件的发件人；源码使用 `??`，显式空字符串仍传空，不会回退账号。当前 Compose 默认传空字符串，需根据邮件服务配置有效发件人 |

LANGSMITH_TRACING、LANGSMITH_API_KEY、LANGSMITH_PROJECT由Compose传给进程；项目wrapOpenAI，具体启用/传输行为由依赖读取。没有源码自定义完整trace采集器。Key/SMTP密码真实值不应进入文档。

其中 LANGSMITH_PROJECT 在 Compose 默认 gist-agent，LANGSMITH_TRACING 默认 false；API 与 Worker 的 LlmClient 都有包装。它们影响依赖侧模型追踪，不决定平台自己的 generation 事件、执行统计是否落库；这些对象由项目代码另行维护。

## 配置与部署的差异

Compose默认PG容器postgres:5432、Redis:6379，对宿主机分别映射15432/16379；本地进程要使用对应宿主机端口，Web容器映射8080。Vite代理API3000，不随SERVER_PORT自动变化。

源码支持的DB_POOL_MAX、RESPONSE_RESERVE_TOKENS、LLM_PROVIDER、PROCESS_ROLE未在当前Compose runtime字段中显式传递；不能只在宿主机.env填写就假定容器拥有这些变量。Compose未显式覆盖时服务内使用默认值或其他实际注入配置。

调整并发时分别核对 Worker 作业数、三层 Redis 容量和 Agent 连接池，不把其中任一配置当成完整容量控制。调整租约和心跳时一起核对僵尸监控阈值。调整模型时同时核对 API/Worker 的模型记录、thinking 兼容性和本地预算；完整执行边界读[任务生命周期](../guides/generation-lifecycle.md)和[上下文预算](../guides/context-and-state.md)。

[API/Worker Dockerfile](../../apps/api/Dockerfile)以Node22和pnpm9.15.9构建共享依赖；[CI](../../.github/workflows/deploy.yml)执行类型检查和构建，SSH部署先备份、停止应用、运行迁移/初始化再启动。这里只说明配置，不证明已部署或备份可恢复。
