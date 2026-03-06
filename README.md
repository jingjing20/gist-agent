# AI Data Analysis (Data Agent)

基于大语言模型 (LLM) 的智能数据分析平台。用户通过自然语言即可直接与数据库对话，由 Agent 自动理解意图、排查数据字典、生成 SQL、查询执行并最终输出详尽的分析结论。

## 💡 核心特性

- **Text-to-SQL 与智能洞察**
  采用基于 OpenAI Function Calling 的 Agent 架构。系统会在后台自行规划工具调用（查询字典、检查权限、执行 SQL，流式输出），无需由于上下文遗漏导致的无效对话。
- **动态 Schema 全自动感知**
  剔除了硬编码的数据字典。服务端在对话发生时，实时查询 MySQL 原生的 `information_schema` 视图，保证大模型永远感知最新的表结构和字段注释。你甚至随时可以在库里建一张新业务表，无需更改哪怕一行代码系统就能立即通过对话对齐你的数据。
- **打字机流式输出体验**
  前后端均接入 SSE (Server-Sent Events)。无论是 Agent 书写的 SQL 还是总结出的洞察报告，都会以动态流呈现到前端页面，降低首字节响应时间。
- **动态对话隔离与持久化**
  利用 NestJS Conversation Module 及 Pinia Store 将侧边栏的对话会话和查询块 (Blocks) 自动存入 MySQL，页面刷新不再丢失历史对话。
- **权限与风控系统演示**
  Agent 内置了一套库表权限检查逻辑。当识别到用户需要访问某个拦截名单中的数据表（如 `user_behavior_log`），Agent 会自主中断 SQL 生成，向前端抛出阻断信令，渲染权限申请专用 UI。

## 🛠 技术栈

采用 **Monorepo** 架构 (`pnpm workspace`) 进行工程化管理。

- **Web 侧**
  - [Vue 3](https://vuejs.org/) (Composition API / `<script setup>`)
  - [Vite](https://vitejs.dev/)
  - [Pinia](https://pinia.vuejs.org/) (集中状态管理)
  - highlight.js、marked (动态代码块与 Markdown 渲染)
- **Server 侧**
  - [NestJS](https://nestjs.com/) (企业级 Node.js 框架)
  - [OpenAI NodeJS SDK](https://github.com/openai/openai-node) (LLM 客户端接入)
  - `mysql2/promise` (高性能连接池与底层通信)
  - TypeScript 工具链执行环境

## 🚀 运行与启动

### 1. 环境准备

- 开发环境：Node.js >= 18.x
- 包管理工具：`pnpm`
- 数据库：MySQL >= 5.7 或 8.x

### 2. 安装与配置

在项目根目录下，使用 pnpm 初始化整个命名空间的依赖包：
```bash
pnpm install
```

在根目录创建或拷贝环境变量配置文件 `.env`：
```env
# 大模型配置
OPENAI_API_KEY=sk-xxxx...
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=gpt-4o

# 数据库连接
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=root
DB_PASSWORD=your_password
DB_NAME=ai_analysis
```

### 3. 初始化数据库结构（可选）

为演示分析效果，工程内提供了一套 Mock 表及随机数据种子生成脚本。执行以下命令即可生成所需的物理表（`platform_info`, `daily_active_stats`, `user_behavior_log` 等）及基础统计：
```bash
pnpm --filter server run init-db
```

### 4. 启动集群

在项目根目录运行并发启动命令，极速拉起所有业务层：
```bash
pnpm dev
```
也可拆分终端运行：
-  **启动服务端**: `pnpm dev:server`  — 运行于 3000 端口
-  **启动 Web 界面**: `pnpm dev:web` — Vite 本地服务器默认于 5173 端口

现在，只要打开 http://localhost:5173，立即开始你的无缝数据对话分析工作吧！
