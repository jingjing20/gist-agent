# 部署与运维

本文对应当前 PostgreSQL / Redis / API / Worker / Web 架构。架构、业务流程与数据结构见[项目文档](README.md#项目文档)，当前实现限制见[能力与运行边界](docs/limitations.md)。

## 环境和配置

本机开发见[README](README.md)。容器部署需要 Docker 和 Docker Compose；镜像使用 Node.js 22、pnpm 9.15.9、PostgreSQL 17 和 Redis 7。

首次配置可复制 .env.example 为 .env；已有文件不要覆盖。填写自己的凭据，不提交 .env。

| 配置 | 用途 |
| --- | --- |
| OPENAI_API_KEY / OPENAI_BASE_URL / OPENAI_MODEL | 模型凭据、API 地址及模型名；未设置模型名时源码回退为 gpt-4o |
| DB_HOST / DB_PORT / DB_USER / DB_PASSWORD / DB_NAME | PostgreSQL 连接；本机默认 5432，Compose 内连接 postgres:5432 |
| AGENT_DB_USER / AGENT_DB_PASSWORD | 独立查询账号；init-db 配置后创建并授权，NODE_ENV=production 时缺失会报错 |
| AGENT_DB_POOL_MAX | 查询连接池大小，默认 4 |
| REDIS_URL / EVENT_KEY_PREFIX | 队列、事件连接及命名空间 |
| JWT_SECRET | 必填登录签名密钥；生产至少 32 字符，禁止示例值 |
| APP_ORIGIN | 密码重置邮件中的 Web 地址 |
| GENERATION_PENDING_TIMEOUT_MS | 未领取任务最大排队时间，默认 600000ms |
| SMTP_HOST / SMTP_PORT / SMTP_SECURE / SMTP_USER / SMTP_PASS / SMTP_FROM | 密码找回邮件 |
| LLM_THINKING_CONTROL / LLM_REASONING_EFFORT | 供应商思考参数兼容策略 |
| MAX_CONTEXT_TOKENS | 可选上下文窗口覆盖值，默认按模型能力表选择 |
| WORKER_CONCURRENCY / USER_GENERATION_CONCURRENCY_LIMIT | Worker / 用户并发，默认 5 / 5 |
| GENERATION_GLOBAL_CONCURRENCY / GENERATION_PROVIDER_CONCURRENCY | 全局 / 供应商并发，默认 20 / 10 |

其他配置见[示例文件](.env.example)与[配置代码](packages/config/src/index.ts)。模型客户端通过 `wrapOpenAI` 接入 LangSmith。启用追踪需配置 LANGSMITH_TRACING、LANGSMITH_API_KEY、LANGSMITH_PROJECT，Compose 已映射到使用模型的容器；实际发送是否成功需检查运行环境。

### Compose 配置

[docker-compose.yml](docker-compose.yml) 使用共享环境映射，将 NODE_ENV=production、数据库/只读账号、模型、思考、上下文、业务时区和 LangSmith 参数传入对应进程。DB_PASSWORD、AGENT_DB_USER、AGENT_DB_PASSWORD、JWT_SECRET 缺失时拒绝容器配置；JWT_SECRET 在生产环境至少 32 字符，不能使用示例值。

API 还使用 APP_ORIGIN 生成密码找回链接，部署时填写用户访问的 HTTPS 页面地址；本机开发可用 http://localhost:5173。首页推荐与字段注释增强也使用同一模型配置。Redis 使用 AOF 和 redis_data 命名卷，普通重建保留队列数据。

## 首次容器启动

确认配置后执行：

```bash
docker compose up -d --wait postgres redis
docker compose --profile tools run --rm --build init-db
docker compose up -d --build api worker web
docker compose ps
```

init-db 创建数据库和当前应用结构，确保默认数据源存在，并创建/更新配置的查询角色。它不生成业务样例、不删除既有业务表。首次使用由用户创建数据源并上传文件。普通重启不需要重复运行。

| 服务 | 容器端口 | 宿主机访问 |
| --- | --- | --- |
| postgres | 5432 | 127.0.0.1:15432 |
| redis | 6379 | 127.0.0.1:16379 |
| api | 3000 | 未直接映射，由 Web Nginx 代理 |
| worker | 健康端口 3001 | 未直接映射 |
| web | 80 | 127.0.0.1:8080 |

本机访问 http://127.0.0.1:8080。远程部署可由宿主机 Nginx / HTTPS 代理到该地址，或用 SSH 隧道。当前配置不直接开放公网 80。反向代理需保留 SSE 长连接并关闭响应缓冲。

## 数据库结构与开发重建

当前结构由 [schema.ts](packages/database/src/schema.ts) 的 applyCurrentSchema 定义。初始化、迁移及 API/Worker 连接时校验所需列和 PostgreSQL 类型；不匹配即报错，不继续带错结构运行。

- 全新库：pnpm init-db，先按 README 构建共享依赖。
- 当前库补齐缺失结构：pnpm migrate:database。此命令删除旧业务口径表及分析草稿中的旧 definitions 字段，创建数据源记忆表并补齐证据列；保留会话、消息和分析状态，不转换旧业务口径数据。
- 需要重建分析结构的开发库：只有明确接受清空分析数据时，才运行以下命令。

```bash
pnpm migrate:database --reset-analysis
```

重建在事务中删除并重建会话、消息、任务、事件、证据、分析状态和记忆，同时删除旧业务定义、废弃记忆及旧展示表。账号、数据源、权限与用户业务表保留。存在活动任务时拒绝执行；操作前停止新任务创建，完成或取消已有任务。

这不是日常启动命令，删除的数据需依靠已有备份恢复。不提供旧对话或旧记忆转换，API、Worker、Web 应使用匹配代码版本。

## 日常运维

```bash
docker compose logs -f api worker
docker compose restart api worker
docker compose up -d --build
docker compose down
```

down 保留命名数据卷；追加 -v 会删除 PostgreSQL 和 Redis 数据卷，不用于普通重启。修改 .env 后，确认 Compose 映射存在，再用 docker compose up -d 重建受影响容器；restart 不更新容器环境。

### SSH 访问远程 PostgreSQL

```bash
ssh -N -L 5433:127.0.0.1:15432 user@prod-host
```

客户端选择 PostgreSQL，连接 127.0.0.1:5433，使用部署配置的数据库名及凭据，并保持 SSH 会话开启。

### 常见问题

| 现象 | 检查项 |
| --- | --- |
| Web 502 | api 日志、Nginx 上游、容器状态 |
| 页面可打开但分析不执行 | worker、Redis、队列和模型配置 |
| 数据库连接失败 | 宿主机 15432 与容器 5432 是否混用，账号和库名是否一致 |
| 查询账号错误 | init-db 是否取得同一组 AGENT_DB 凭据并授权 |
| Schema 不匹配 | 当前结构及匹配的 API / Worker，检查实际部署结构和迁移结果 |
| 环境变量未生效 | Compose 映射是否存在，容器是否重建 |

## GitHub Actions

[deploy.yml](.github/workflows/deploy.yml) 在推送 main 或手动触发时：

1. 使用 Node.js 22 安装依赖，运行 typecheck 和 build。
2. 成功后通过 SSH 进入服务器项目目录。
3. 执行 git pull、docker compose build，启动 PostgreSQL 和 Redis，并停止旧版应用容器。
4. 用 pg_dump 写入 backups/pre-deploy-时间戳.sql，限制文件权限，随后执行 migrate:database 和 init-db。
5. 成功后启动 API、Worker 和 Web。同一生产发布组串行执行，防止并行部署。

| Secret | 用途 / 默认值 |
| --- | --- |
| SERVER_HOST | 服务器地址 |
| SERVER_USER | SSH 用户 |
| SSH_PRIVATE_KEY | SSH 私钥 |
| SERVER_PORT | SSH 端口，默认 22 |
| DEPLOY_PATH | 项目目录，默认 /home/ai-data-analysis |

服务器需预先准备代码目录、Docker 和 .env。现有流程先停应用，再初始化，成功后启动应用；初始化失败会使应用保持停止。流程包含数据库备份，但没有自动回滚或无停机发布。迁移/初始化失败会保留应用停止状态；查看日志后选择修复重试，或恢复匹配的代码版本及备份。backups 不提交 Git，应另行安排备份保留与异地保存。

## 版本升级注意事项

升级后已有 JWT 和此前生成的密码重置链接需要重新获取。密码修改后重新登录；旧 JWT 在后续请求中因凭据版本不匹配而被拒绝。新事件写入已有 generation_event 表，不需要新建事件表；旧记录没有完整事件时使用消息快照恢复。

既有库先运行 migrate:database，再运行 init-db 更新查询角色。不自动删除业务表、历史事件或分析数据；仅在明确需要重建开发分析域时使用 --reset-analysis。
