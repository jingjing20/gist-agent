# Gist Agent

<img src="./apps/web/public/gist-agent-banner.png" width="600" alt="Gist Agent" />

用自然语言分析 CSV / Excel 数据，查看 SQL、查询结果和结论依据。

[English](README.en.md) · 简体中文

## 项目定位

Gist Agent 是用于学习和验证 Agent 工程的数据分析项目。模型在权限和执行预算内选择工具，围绕同一问题连续查询、验证解释，并通过证据引用回答。

当前仅使用新分析核心，不提供旧对话、旧记忆或旧数据库结构兼容。代码实现、快速验证与真实业务验收分别记录，见[交付与验收状态](docs/agent-refactor/05-delivery-and-validation.md)。

## 当前能力

| 能力 | 实现方式 |
| --- | --- |
| 数据接入 | CSV / Excel、多 Sheet 选择、字段推断及 PostgreSQL 参数化批量 INSERT |
| 单 Agent 分析 | 显式更新状态，按需读取 Schema 与记忆，查询、验证并结构化提交结果 |
| 数据源记忆 | 文本记忆；手动添加、明确对话指令直接保存、提炼候选确认与版本管理 |
| 多轮状态 | 保存问题、时间、筛选、粒度、临时口径和假设；条件变化后检查证据适用性 |
| 查询安全 | 单条 SELECT、AST 校验、表字段权限、行数限制、只读连接和查询超时 |
| 显式 SQL 纠错 | 可修正错误返回主循环，修正后重新校验；执行器内部不调用模型 |
| 可追溯结果 | 结论关联证据，可展开口径、SQL、条件、结果和质量限制；图表引用 Artifact |
| 上下文管理 | 按固定优先级选择状态、定义、完整工具交互和历史，记录选择与省略原因 |
| 后台执行与 SSE | API 接收请求，Worker 执行任务；支持事件恢复和显式取消 |
| 外围功能 | JWT 登录、SMTP 密码找回、数据源管理、授权、推荐问题及 Schema 注释增强 |

Schema 自动注释是模型推断的线索，不等于用户确认的业务事实。证据可追溯也不等于结论已经被证明正确。

## 快速启动

推荐与 Docker / CI 对齐使用 Node.js 22、pnpm 9.15.9；容器数据库和队列版本为 PostgreSQL 17、Redis 7。

### 1. 安装与配置

```bash
pnpm install
cp .env.example .env
```

已有 .env 时保留原文件。填写模型 Key、Base URL、可用模型名、数据库凭据、JWT_SECRET 及独立查询账号 AGENT_DB_USER / AGENT_DB_PASSWORD。示例模型名需要按供应商实际支持情况调整。

### 2. 准备数据库和 Redis

已有本地服务时使用实际地址；也可以仅通过 Compose 启动依赖：

```bash
docker compose up -d postgres redis
```

使用此方式时，本机开发进程的 .env 需要设置：

```dotenv
DB_HOST=127.0.0.1
DB_PORT=15432
REDIS_URL=redis://127.0.0.1:16379
```

Compose 内部使用 postgres:5432 和 redis:6379，不要与宿主机映射端口混淆。

### 3. 构建依赖并初始化

```bash
pnpm --filter @gist/api... build
pnpm init-db
```

初始化创建当前应用表、合成业务样例及已配置的只读查询账号，会写入数据库。旧开发库的处理方式见[部署指南](DEPLOY.md)。

### 4. 启动

```bash
pnpm dev
```

Web 默认 http://localhost:5173，API 默认 http://localhost:3000。也可分别运行 pnpm dev:api、pnpm dev:worker 和 pnpm dev:web。仅启动 API 不会执行分析任务。

## 架构与代码入口

```text
apps/api            HTTP、鉴权、任务创建、Outbox 和 SSE
apps/worker         队列消费、Agent、工具、状态与证据
apps/web            Vue 3、Pinia、ECharts、多会话和证据展示
packages/contracts  共享协议与领域类型
packages/config     环境配置
packages/database   PostgreSQL 客户端、表结构与记忆仓库
packages/llm        OpenAI-compatible 模型适配
```

后端使用 NestJS，队列使用 BullMQ / Redis。详见[运行时设计](docs/agent-refactor/02-agent-runtime.md)。

## 演示与验证

以下视频可能包含历史界面，当前能力以代码及设计文档为准：

- [演示一](https://github.com/user-attachments/assets/47fd3e74-0748-4505-822a-447fb07f992d)
- [演示二](https://github.com/user-attachments/assets/c6252c3d-237f-4809-92f0-3e850702a8b5)
- [演示三](https://github.com/user-attachments/assets/04861aa2-b6cb-4767-a96d-6f4a49a4cfe6)

快速检查与真实服务验收的边界见[验证说明](docs/agent-refactor/05-delivery-and-validation.md)。[固定合成数据与标准答案](benchmarks/saas-growth/README.md)不代表真实公司数据或通用准确率。

## 文档导航

- [部署与运维](DEPLOY.md)
- [设计入口](docs/agent-refactor/README.md)
- [业务验收步骤](benchmarks/saas-growth/acceptance-walkthrough.md)
- [项目亮点](docs/career/resume-highlights.md)
- [面试参考](docs/career/agent-interview.md)

## 许可证

[MIT](LICENSE)

提示词与字段注释增强的当前实现、接口和人工验收清单见[重构说明](docs/prompt-refactor.md)。
