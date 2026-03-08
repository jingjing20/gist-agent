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