# Gist Agent

<img src="./apps/web/public/gist-agent-banner.png" width="600" alt="Gist Agent" />

用自然语言分析 CSV / Excel 数据，查看查询结果、SQL 和分析依据。

[English](README.en.md) · 简体中文

## 项目能力

- 数据源管理、CSV / Excel 多 Sheet 上传与共享授权。
- 单 Agent 按需读取 Schema、业务记忆，执行只读 SQL，流式输出文字、表格和图表。
- 多会话、后台任务、显式取消、失败重试及 SSE 重连恢复。
- 数据源文本记忆、候选确认、编辑与版本历史。
- 字段注释建议预览、人工应用及推荐问题。
- JWT 注册登录、个人设置及邮件找回；修改密码需要当前密码，并使旧令牌在后续鉴权中失效。

数据源是同一 PostgreSQL 数据库中的逻辑工作空间，当前没有外部数据库连接功能。图表和表格引用保存的查询结果；自然语言结论没有逐数字自动核验。模型建议的字段注释不能代替已确认的业务口径。

## 快速启动

使用 Node.js 22、pnpm 9.15.9。依赖 PostgreSQL 和 Redis；Compose 使用 PostgreSQL 17、Redis 7。

### 1. 安装与配置

```bash
pnpm install
cp .env.example .env
```

已有 `.env` 时保留原文件。填写模型 Key、Base URL、可用模型名、数据库凭据、有效 JWT_SECRET（生产至少 32 字符）、APP_ORIGIN 和独立查询账号 AGENT_DB_USER / AGENT_DB_PASSWORD。模型需要支持 Chat Completions 工具调用和流式输出。

### 2. 一键启动（任选一种）

已有 `.env` 后，在项目根目录执行一条命令即可。

| 方式 | 启动命令 | 访问地址 | 停止 |
| --- | --- | --- | --- |
| 本机数据库 + 应用热更新 | `pnpm dev:local` | http://localhost:5173 | 终端按 `Ctrl+C`，同时停止应用和 Homebrew 数据库 |
| Docker 数据库 + 本机应用热更新 | `pnpm dev:docker` | http://localhost:5173 | 终端按 `Ctrl+C`，同时停止应用和容器数据库，保留数据卷 |

本机模式要求 macOS / Homebrew、Node.js 22 和 pnpm 9.15.9。脚本会补装缺少的 PostgreSQL 17 / Redis、安装项目依赖、构建、启动数据库、初始化账号和表，再启动 Web / API / Worker。初始化使用本机系统用户对应的 PostgreSQL 管理员，日常应用使用 `.env` 中的独立账号。仅支持本地数据库地址。

当前电脑的 `.env` 已配置好 PostgreSQL `5433`、Redis `6380`，避开既有 Docker 容器。其他电脑请确保 `.env` 地址与 Homebrew 服务的实际监听端口一致（新安装默认 `5432` / `6379`）；脚本不会更改服务端口或覆盖密钥。

Docker 数据库模式要求 Docker Desktop 已启动，本机已安装 Node.js 22 和 pnpm 9.15.9。脚本会安装项目依赖、构建、只启动 PostgreSQL / Redis 容器，然后在本机初始化数据库并启动 Web / API / Worker，支持应用热更新。无需手动安装依赖或初始化，也无需修改 `.env`：脚本仅为本次运行覆盖 DB_HOST=127.0.0.1、DB_PORT=15432、REDIS_URL=redis://127.0.0.1:16379、APP_ORIGIN=http://localhost:5173，密钥仍从原 `.env` 加载。`pnpm stop:docker` 可单独停止这两个数据库容器；完整停止使用启动终端的 `Ctrl+C`。

两种方式的数据库独立，数据不会自动同步。初始化保留已有业务数据，不导入旧电脑的数据。首次使用时注册账号、创建数据源并上传文件；默认本地源禁止上传。已有数据库的迁移与运维见[部署指南](DEPLOY.md)。

## 工程结构与命令

| 目录 | 职责 |
| --- | --- |
| apps/web | Vue 3、Pinia、ECharts，页面与结果展示 |
| apps/api | NestJS REST、鉴权、任务创建、Outbox 与 SSE |
| apps/worker | BullMQ 消费、Agent、工具、状态与证据 |
| packages/contracts | 共享协议与领域类型 |
| packages/config | 环境配置 |
| packages/database | PostgreSQL 客户端、DDL 与记忆仓库 |
| packages/llm | OpenAI-compatible 模型适配与提示词 |
| scripts | 数据库迁移 |

| 命令 | 用途 |
| --- | --- |
| pnpm dev | 同时启动 API、Worker、Web |
| pnpm dev:api / dev:worker / dev:web | 分别启动进程 |
| pnpm typecheck | 工作区类型检查 |
| pnpm build | 构建工作区 |
| pnpm init-db | 初始化数据库、默认源与查询账号 |
| pnpm migrate:database | 运行现有结构升级脚本 |
| pnpm migrate:memory-provenance | 升级记忆来源关联约束 |

## 项目文档

以下是一套当前实现说明；功能变更时同步更新对应页面。实现说明以源码、共享契约和 DDL 为依据，部署配置与线上数据需要在实际环境核对。

| 文档 | 主要回答的问题 |
| --- | --- |
| [整体介绍](docs/overview.md) | 项目是什么、工程怎样组织、业务对象如何区分、应该怎样阅读 |
| [产品](docs/product.md) | 用户功能、业务规则、权限和场景之间的关系 |
| [系统架构](docs/architecture.md) | 进程职责、通信、存储、事务和执行边界 |
| [Agent机制](docs/agent.md) | 模型上下文、工具循环、分析状态、记忆版本和证据复用 |
| [三轮对话实例](docs/walkthrough.md) | 用具体参数和状态变化理解查询、追问与证据复用 |
| [核心契约](docs/contracts.md) | 创建、同步、历史、SSE、工具与前端块的字段和衔接 |
| [核心业务流程](docs/workflows.md) | 七条从用户动作到页面、服务、数据和反馈的完整链路 |
| [前端](docs/frontend.md) | 页面与Store、流式事件、结果阅读及修改入口 |
| [服务端](docs/backend.md) | API参数与权限、业务服务、后台任务和契约 |
| [数据库](docs/database.md) | 六组应用实体、核心关系、状态与版本、删除和迁移 |
| [能力与运行边界](docs/limitations.md) | 代码保证、模型要求、实际环境未知及维护注意事项 |
| [部署与运维](DEPLOY.md) | 配置、容器部署、迁移及故障排查 |

第一次阅读建议：整体介绍 → 产品 → 系统架构 → 三轮对话实例 → Agent机制。修改功能时按对应前端、服务端和数据库章节定位，能力与运行边界用于判断保证范围。文档按主题维护，不重复堆积重构过程或历史方案。

文档更新范围与核对顺序见[维护约定](docs/overview.md#9-文档维护约定)。

## 许可证

[MIT](LICENSE)
