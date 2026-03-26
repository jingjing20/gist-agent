# AI Data Analysis (Data Agent)

基于大语言模型 (LLM) 的智能数据分析平台。用户上传自己的数据文件（CSV / Excel），通过自然语言与数据对话，由 Agent 自动生成 SQL、执行查询、输出分析结论并渲染可交互图表。

## 核心特性

- **文件上传与自动建表**
  支持上传 `.csv` / `.xlsx` / `.xls` 文件（单文件上限 20 MB，50,000 行）。服务端自动推断列类型（`TEXT` / `BIGINT` / `DOUBLE`）、清洗脏数据、去重列名，并在 MySQL 中创建对应物理表，全程无需用户干预。

- **数据源管理**
  每个用户可创建多个独立数据源，每个数据源下可上传多张数据表。对话时按数据源隔离上下文，Agent 只感知当前数据源的表结构，互不干扰。

- **Text-to-SQL 与智能洞察**
  基于 OpenAI Function Calling 的 ReAct Agent 架构。主控 Agent 在后台自主规划工具调用链（分析数据语义 → 生成并执行 SQL → 提炼结论 → 决策是否生成图表），无需多轮对话引导。

- **动态 Schema 感知**
  服务端在每次对话时实时查询 `information_schema`，大模型始终拿到最新的表结构与字段信息，新增数据表无需改动任何代码即可立刻被感知和查询。

- **ECharts 动态可视化**
  Agent 在判断结果适合可视化时，自动调用 `generate_chart` 工具生成图表配置，前端 `ChartBlock` 组件直接渲染出可交互的折线图、柱状图、饼图或散点图。

- **SSE 流式输出**
  前后端全链路接入 SSE (Server-Sent Events)。SQL 代码、查询结果表格、分析结论、图表数据均以独立 Block 事件实时推送到前端，首字节延迟极低。

- **对话持久化**
  会话列表与每条消息的 Blocks（SQL 块、表格块、图表块、Markdown 块）均落库 MySQL，刷新页面不丢失历史。

- **用户认证**
  内置注册 / 登录 / 忘记密码流程，基于 JWT 鉴权。数据源与对话数据按用户隔离，不同用户之间数据完全独立。

## 技术栈

采用 **Monorepo** 架构 (`pnpm workspace`) 进行工程化管理。

- **Web 侧**
  - [Vue 3](https://vuejs.org/) (Composition API / `<script setup>`)
  - [Vite](https://vitejs.dev/)
  - [Pinia](https://pinia.vuejs.org/) (集中状态管理)
  - [ECharts](https://echarts.apache.org/) (图表渲染)
  - highlight.js、marked (代码块与 Markdown 渲染)
- **Server 侧**
  - [NestJS](https://nestjs.com/) (企业级 Node.js 框架)
  - [OpenAI NodeJS SDK](https://github.com/openai/openai-node) (LLM 客户端接入)
  - `mysql2/promise` (高性能连接池)
  - `csv-parser`、`xlsx` (文件解析)
  - TypeScript

## 运行与启动

### 1. 环境准备

- Node.js >= 18.x
- pnpm
- MySQL >= 5.7 或 8.x

### 2. 安装与配置

```bash
pnpm install
```

在根目录创建 `.env`（参考 `.env.example`）：

```env
# 大模型
OPENAI_API_KEY=sk-xxxx
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=gpt-4o

# MySQL
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=root
DB_PASSWORD=your_password
DB_NAME=ai_analysis

# JWT
JWT_SECRET=change-this-long-random-secret
```

### 3. 初始化数据库

首次运行前执行，创建所需的元数据表结构：

```bash
pnpm --filter server run init-db
```

### 4. 启动

```bash
pnpm dev
```

也可拆分终端运行：
- **服务端**: `pnpm dev:server` — 3000 端口
- **前端**: `pnpm dev:web` — 5173 端口


## F&Q

### 有的功能做成了工具 tool ，有的功能做成了 agent，这个是怎么界定的呢？

这是一个非常本质且关键的架构设计问题。在目前的工程实践中，界定 Tool（工具）和 Agent（智能体）的核心标准是**自治度（Autonomy）**和**逻辑闭环的完备性**。

简单粗暴地打个比方：**工具是“手和眼睛”，能被动干活；而 Agent 是“大脑”，能主动决策。**

以下是具体的界定标准和技术考量：

### 1. Tool（工具）：被动执行的纯函数 / API

如果一个模块符合以下特征，它就必然是 Tool：

*   **确定性映射**：给定确定的输入参数，必定产生预期范围内的输出（无论是成功数据还是明确的错误抛出）。
*   **零自主决策**：它只管“干活”，不管“为什么干”。何时被调用、传入什么参数，完全由外部的大脑（当前的主干 LLM）决定。
*   **职责极端单一**：我们在系统里注册的 `check_table_permission`（比对表名）、`request_table_permissions`（发 SSE 阻断事件）、`generate_chart`（原样推流配置）。大模型在思考后直接传参给它们，它们立刻返回结果给大模型。

### 2. Agent（智能体）：包含独立自治逻辑的执行单元

如果一个模块符合以下特征，它就应该被拔高一层，封装为独立的 Agent：

*   **内部包含决策博弈**：它不仅包含业务代码，内部还包裹着 LLM 的推断逻辑。比如遇到了报错，它内部能抓取错误日志，自行构造一套 Prompt 让 LLM 诊断，然后再发起重试。
*   **拥有独立的上下文（Context）**：它可能有专门针对该垂直领域的 System Prompt，不用关心全局的对话历史，只专注自己领地的问题。
*   **行为边界是“目标驱动”**：调用 Tool 是命令式（“去查这句 SQL”），而调用 Agent 往往是声明式的目标驱动（“去帮我搞定用户的数据获取，随便你怎么折腾”）。

### 结合当前项目的现实解剖

在我们现在的代码库中：

1. **主控 Agent**：现在的 `ChatService.handleChat` 方法本质上就是一个 Orchestrator Agent（编排型智能体）。它有记忆（查 MySQL 历史消息）、有指导思想（System Prompt）、有 ReAct 的思考循环（While 循环直到 isDone 为 true）。
2. **工具箱**：大模型手里拿着的那堆 OpenAPI Function 声明，全是被动工具。
3. **关于你看到的 `SqlExecutorAgent`**：
为了保护主干大模型的 Token 上下文免遭污染，我们将 `SqlExecutorAgent` 设计为一个具备真实容错能力的防腐层。
当 SQL 执行遭遇纯粹的语法层面错误（如 `ER_PARSE_ERROR` 等）时，系统会将其拦截，在内部启动一个廉价且快速的 LLM 会话进行静默修复。而一旦遭遇语义级错误（如表或字段不存在），它会果断放弃修复并将错误毫无保留地抛回给持有完整业务 Schema 的主干大模型，严防模型因缺乏上下文而盲目猜测字段，以此兼顾容错率与数据风控底线。

**所以落地的实用主义总结是：**
如果这个功能只需**“一次调用，直进直出”**，那就写成 Tool 喂给当前大模型。
如果这个功能需要**“在内部自己做多次尝试、自我纠正、或者有大段专有的思维链拆解”**，就绝不能污染主流程，应该单独起一个文件抽离成 Sub-Agent 给主流程去异步唤起。



## 在本地通过 SSH 隧道连接 Docker 中的线上 MySQL

> 假设条件（按自己环境改）：
> - 线上服务器 SSH 地址：`user@prod-host`
> - Docker 容器内 MySQL 端口：`3306`
> - 宿主机通过 `docker-compose.yml` 暴露的端口：`13306`（仅监听在 `127.0.0.1` 上）
> - 本地预留端口（SSH 转发用）：`3307`

### 1. 建立 SSH 隧道

在本地终端执行（建立本地端口 → 线上宿主机 → Docker MySQL 的链路）：

```bash
ssh -L 3307:127.0.0.1:13306 user@prod-host
```

解释：

- `3307`：你本地监听的端口（可以改，只要不冲突）。
- `127.0.0.1:13306`：在线上服务器视角，宿主机监听的 MySQL 映射端口（由 `docker-compose.yml` 中的 `127.0.0.1:13306:3306` 提供）。
- 保持这个 SSH 会话打开期间，你本地的 `127.0.0.1:3307` 就等价于连到 Docker 容器内的线上 MySQL。


### 2. Navicat / DataGrip 配置示例

新建连接 → 选择 MySQL：

- **基本设置**
  - **主机名 / IP 地址**: `127.0.0.1`
  - **端口**: `3307`
  - **用户名**: `root`（或实际线上账号）
  - **密码**: 使用 `.env`/部署配置中的 `DB_PASSWORD`

- **SSH 设置**

  1）**使用外部 SSH 命令建隧道**
  - 只需在终端保持前面那条 `ssh -L` 命令连接，Navicat 不用勾 SSH 选项。
