# Gist Agent (Data Agent)

基于大语言模型 (LLM) 的智能数据分析平台。用户上传自己的数据（CSV / Excel），只需通过自然语言与数据对话，Agent 便能自动生成 SQL、执行查询、提炼结论并动态渲染图表。

## 💡 核心特性

- **开箱即用的数据管道**
  上传 `.csv` 或 `.xlsx` 文件后，服务端会自动推断 Schema、清洗脏数据、去重列名并映射建表，全程零门槛即可对话。
- **动态 Schema 实时感知**
  模型每次交互前动态加载最新的表结构，业务横向扩展或字段变更时，由于无需硬编码，Agent 不受影响即刻适配。
- **ReAct 智能编排底座**
  基于 OpenAI Function Calling 的多步主控 Agent 结构。理解意图 → 构造 SQL → 拦截底层错误重跑/验证 → 输出分析洞察与可视化指令，无需人工诱导。
- **极致流式体验 (SSE)**
  SQL 语句生成、数据抓取过程、图表绘制与分析文字通过分块并行的 Server-Sent Events (SSE) 实时呈现给终端，抹平由于长链调用带来的体感延迟。
- **多租户与数据资产隔离**
  内置用户认证 (JWT + SMTP 恢复)，不同租户的数据源、表空间、会话历史相互强隔离。
- **开箱即用的链路追踪 (Observability)**
  原生集成 LangSmith。只需配置 API Key 即可一键开启全链路追踪，直观洞察 Agent 的 ReAct 推理逻辑、Tool 调用链以及 SQL 执行性能。

## 🛠 技术栈

项目采用 **Monorepo** 架构 (`pnpm workspace`)。
- **Web 端**: Vue 3 (Composition API), Vite, Pinia, ECharts.
- **Server 端**: NestJS, OpenAI Node SDK, MySQL, JWT.

## 🚀 快速启动

### 1. 环境依赖
- Node.js >= 18.x
- pnpm >= 8.x
- MySQL >= 5.7 / 8.x

### 2. 获取代码与安装依赖
```bash
git clone <your-repo-url>
cd ai-data-analysis
pnpm install
```

### 3. 初始化配置
复制提供好的 `.env.example`，创建你的环境变量文件：
```bash
cp .env.example .env
```
> **注意**: 请务必在 `.env` 中填写正确的 `OPENAI_API_KEY`、`DB_PASSWORD` 及其他关联服务配置。

### 4. 数据库初始化
首次部署前，强制执行该命令创建项目运行时所依赖的所有元数据表（对话历史、数据源记录等）：
```bash
pnpm run init-db
```

### 5. 启动项目 (本地开发环境)
```bash
# 一键并联启动服务端与前端
pnpm dev
```
成功启动后：
- 前端运行在：`http://localhost:5173`
- 后端 API 在：`http://localhost:3000`

> 🚀 **生产环境部署？**
> 如果要在云服务器上线，关于 **Docker Compose 一键编排**、**Nginx 反代映射** 及 **GitHub Actions 自动 CI/CD 构建** 等工业级操作步骤，请直接查阅专用的 **[生产部署与运维指南 (DEPLOY.md)](./DEPLOY.md)**。

---

## 🏛 架构与扩展

如果需要向本项目扩展功能，请首先阅读：
- **[常见问题与运维实践 (FAQ)](./FAQ.md)**：包含关于 **Tool 与 Agent 边界的重度讨论**，以及**通过 SSH 连接线上 Docker 数据库**等实操指引。

简言之：
- **Tool（工具）**: 纯净无状态的被动逻辑，供大模型控制传参调用。
- **Sub-Agent（子智能体）**: 若功能需要循环推演、容错修正（如 `SqlExecutorAgent` 处理 SQL 纠错），必须封装为独立 Agent，严防污染主流程的 Token 窗口。

## 📄 许可证

本项目基于 [MIT License](LICENSE) 协议开源。
