# 部署与运维

本文对应当前 PostgreSQL / Redis / API / Worker / Web 架构。项目验收状态见[交付记录](docs/agent-refactor/05-delivery-and-validation.md)。

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
| JWT_SECRET | 登录签名密钥 |
| SMTP_HOST / SMTP_PORT / SMTP_SECURE / SMTP_USER / SMTP_PASS / SMTP_FROM | 密码找回邮件 |
| LLM_THINKING_CONTROL / LLM_REASONING_EFFORT | 供应商思考参数兼容策略 |
| MAX_CONTEXT_TOKENS | 可选上下文窗口覆盖值，默认按模型能力表选择 |
| WORKER_CONCURRENCY / USER_GENERATION_CONCURRENCY_LIMIT | Worker / 用户并发，默认 5 / 5 |
| GENERATION_GLOBAL_CONCURRENCY / GENERATION_PROVIDER_CONCURRENCY | 全局 / 供应商并发，默认 20 / 10 |

其他配置见[示例文件](.env.example)与[配置代码](packages/config/src/index.ts)。示例中的 LangSmith 变量当前没有对应运行时接入，填写 Key 不会自动开启追踪。

### Compose 配置缺口

Compose 的 .env 用于变量替换，不会自动将所有变量注入容器。当前 [docker-compose.yml](docker-compose.yml) 未传入 AGENT_DB_*、模型思考参数等配置，也未设置 NODE_ENV=production。原样启动不能视为已启用独立只读账号或生产配置。

需要独立查询账号时，在 api、worker、init-db 的 environment 中都补充以下映射，先初始化账号，再启动应用：

```yaml
AGENT_DB_USER: ${AGENT_DB_USER}
AGENT_DB_PASSWORD: ${AGENT_DB_PASSWORD}
AGENT_DB_POOL_MAX: ${AGENT_DB_POOL_MAX:-4}
```

思考参数按需传入 api 和 worker；并发及上下文变量也需显式传给使用它的进程。本轮文档整理未修改 Compose 或应用行为。

## 首次容器启动

确认配置及上述映射后执行：

```bash
docker compose up -d postgres redis
docker compose --profile tools run --rm --build init-db
docker compose up -d --build api worker web
docker compose ps
```

init-db 创建当前结构、演示数据及配置的查询角色。它不是纯结构迁移：每次会调用样例初始化逻辑，删除旧 basic_platform_demo 目录及 platform_info、daily_active_stats、user_behavior_log 三张旧样例表；当前 SaaS 表非空时不会重新插入种子行。普通重启不需要重复运行。

| 服务 | 容器端口 | 宿主机访问 |
| --- | --- | --- |
| postgres | 5432 | 127.0.0.1:15432 |
| redis | 6379 | 127.0.0.1:16379 |
| api | 3000 | 未直接映射，由 Web Nginx 代理 |
| worker | 健康端口 3001 | 未直接映射 |
| web | 80 | 127.0.0.1:8080 |

本机访问 http://127.0.0.1:8080。远程部署可由宿主机 Nginx / HTTPS 代理到该地址，或用 SSH 隧道。当前配置不直接开放公网 80。反向代理需保留 SSE 长连接并关闭响应缓冲。

## 数据库结构与开发重建

当前结构由 [schema.ts](packages/database/src/schema.ts) 的 applyCurrentSchema 定义。

- 全新库：pnpm init-db，先按 README 构建共享依赖。
- 当前库补齐缺失结构：pnpm migrate:database。不回填历史数据，不保证转换任意旧结构；检测到已知废弃结构会拒绝提交。
- 旧测试库：只有明确接受清空分析数据时，才运行以下命令。

```bash
pnpm migrate:database --reset-analysis
```

重建在事务中删除并重建会话、消息、任务、事件、证据、分析状态和业务定义，同时删除废弃记忆及旧展示表。账号、数据源、权限与业务样例表保留。存在活动任务时拒绝执行；操作前停止新任务创建，完成或取消已有任务。

这不是日常启动命令，删除的数据需依靠已有备份恢复。不提供旧对话或旧记忆转换，不再使用 ANALYSIS_CORE 双核开关。API、Worker、Web 应使用匹配代码版本。

## 日常运维

```bash
docker compose logs -f api worker
docker compose restart api worker
docker compose up -d --build
docker compose down
```

down 保留命名数据卷；追加 -v 会删除 PostgreSQL 数据卷，不用于普通重启。修改 .env 后，确认 Compose 映射存在，再用 docker compose up -d 重建受影响容器；restart 不更新容器环境。

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
| Schema 不匹配 | 当前结构及匹配的 API / Worker，不套用归档命令 |
| 环境变量未生效 | Compose 映射是否存在，容器是否重建 |

## GitHub Actions

[deploy.yml](.github/workflows/deploy.yml) 在推送 main 或手动触发时：

1. 使用 Node.js 22 安装依赖，运行 typecheck 和 build。
2. 成功后通过 SSH 进入服务器项目目录。
3. 执行 git pull、docker compose build、docker compose up -d。
4. 每次部署执行 init-db，不仅首次部署。

| Secret | 用途 / 默认值 |
| --- | --- |
| SERVER_HOST | 服务器地址 |
| SERVER_USER | SSH 用户 |
| SSH_PRIVATE_KEY | SSH 私钥 |
| SERVER_PORT | SSH 端口，默认 22 |
| DEPLOY_PATH | 项目目录，默认 /home/ai-data-analysis |

服务器需预先准备代码目录、Docker 和 .env。现有流程先启动应用再初始化，且未区分发布与样例数据维护；正式发布前需另行评估和调整。本轮未修改 workflow 或执行部署。
