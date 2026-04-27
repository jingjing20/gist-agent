# Gist Agent Java Server

Gist Agent 后端的 Spring Boot 重写版本，功能对齐原 NestJS `server/` 实现。Java 21 + Spring Boot 3.5。

## 模块说明

```
com.gistagent/
├── auth/                # 认证：JWT 签发/校验、注册登录、SMTP 密码找回
├── chat/                # Agent Loop 核心：SSE 流式推送、多轮对话编排
│   ├── agents/          # 子 Agent —— SQL 自愈执行器、语义蒸馏器
│   └── tools/           # Function Calling 工具注册（Tool 接口 + Registry 自动发现）
├── common/              # 全局异常处理、健康检查
├── config/              # Spring 配置类：安全策略、OpenAI Client、CORS
├── conversation/        # 会话与消息的 CRUD 持久化
├── database/            # Schema 读取、表权限校验、缓存
├── datasource/          # 数据源管理、CSV/Excel 上传建表、Schema 增强、推荐问题
├── llm/                 # OpenAI SDK 封装（blocking + streaming）
└── user/                # 用户信息、修改密码
```

## 重要文件说明

这部分按“你第一次看 Java/Spring Boot 项目时应该先看哪里”的顺序写。

### 项目根目录

| 文件 | 作用 |
|---|---|
| `README.md` | 当前文档。先看这里，了解这个服务怎么启动、依赖什么、目录怎么分。 |
| `build.gradle.kts` | Gradle 构建配置。相当于 Java 项目的依赖清单和构建脚本，里面声明了 Spring Boot、MySQL、OpenAI SDK、JWT、CSV/Excel 解析等依赖。 |
| `settings.gradle.kts` | Gradle 项目名称配置。这个项目名是 `gist-agent-server`。 |
| `gradlew` | macOS/Linux 下使用的 Gradle Wrapper 启动脚本。你不需要本机提前安装 Gradle，直接执行 `./gradlew bootRun`。 |
| `gradlew.bat` | Windows 下使用的 Gradle Wrapper 启动脚本。 |
| `gradle/wrapper/gradle-wrapper.properties` | 指定 Gradle Wrapper 下载哪个 Gradle 版本。当前使用 Gradle 8.14.4。 |
| `gradle/wrapper/gradle-wrapper.jar` | Gradle Wrapper 自己的运行文件。不要手动改。 |
| `Dockerfile` | Docker 镜像构建文件。先用 JDK 构建 jar，再用 JRE 运行 jar。 |
| `.dockerignore` | Docker 构建时排除不需要复制进镜像的文件。 |
| `.gitignore` | Git 忽略规则。比如构建产物、IDE 临时文件不应该提交。 |
| `.gitattributes` | Git 对文本文件、换行符等行为的配置。 |

### Spring Boot 入口与配置

| 文件 | 作用 |
|---|---|
| `src/main/java/com/gistagent/GistAgentServerApplication.java` | 程序入口。运行它就启动整个 Spring Boot 后端服务。 |
| `src/main/resources/application.yml` | 服务配置文件。端口、`/api` 前缀、MySQL、SMTP、JWT、OpenAI、日志等级都在这里读环境变量。 |
| `src/main/java/com/gistagent/config/AppProperties.java` | 把 `application.yml` 里的 `app.*` 配置映射成 Java 对象，代码里通过它读取 JWT、OpenAI、SMTP 配置。 |
| `src/main/java/com/gistagent/config/SecurityConfig.java` | Spring Security 配置。决定哪些接口需要登录、JWT 过滤器怎么接入、密码如何加密。 |
| `src/main/java/com/gistagent/config/WebConfig.java` | Web 层配置，主要处理跨域等 MVC 相关行为。 |
| `src/main/java/com/gistagent/config/OpenAIClientConfig.java` | 创建 OpenAI SDK 客户端，供 `LlmService` 调用。 |

### 通用基础设施

| 文件 | 作用 |
|---|---|
| `src/main/java/com/gistagent/common/ApiException.java` | 业务异常类型。代码主动抛这个异常，表示请求有明确业务错误。 |
| `src/main/java/com/gistagent/common/GlobalExceptionHandler.java` | 全局异常处理器。把 Java 异常转换成前端能读的 HTTP 错误响应。 |
| `src/main/java/com/gistagent/common/HealthController.java` | 健康检查接口，通常用于确认服务是否活着。 |
| `src/main/java/com/gistagent/common/JdbcScalars.java` | JDBC 查询结果的小工具，处理数字、布尔值等基础类型转换。 |

### 认证模块 `auth/`

| 文件 | 作用 |
|---|---|
| `AuthController.java` | 认证接口入口。处理注册、登录、忘记密码、重置密码、获取当前用户。 |
| `AuthService.java` | 认证业务逻辑。校验用户、加密密码、签发 token、处理密码找回。 |
| `JwtTokenService.java` | JWT 签发和解析。登录后返回的 token 就由它生成。 |
| `JwtAuthFilter.java` | 每个请求进来时读取 `Authorization` 头，解析 JWT，并把用户身份放进 Spring Security 上下文。 |
| `JwtAuthEntryPoint.java` | 未登录或 token 无效时，统一返回认证失败响应。 |
| `MailerService.java` | 发邮件服务，用于密码找回。 |
| `AuthenticatedUser.java` | 当前已登录用户的数据结构。 |
| `auth/dto/*.java` | 认证接口的请求/响应数据结构，比如登录请求、注册请求、认证响应。 |

### 用户模块 `user/`

| 文件 | 作用 |
|---|---|
| `UserController.java` | 用户相关接口入口。处理搜索用户、修改资料、修改密码。 |
| `UserService.java` | 用户业务逻辑。访问数据库并执行用户资料更新。 |
| `user/dto/*.java` | 用户接口的数据结构，比如修改昵称、修改密码、用户搜索结果。 |

### 会话模块 `conversation/`

| 文件 | 作用 |
|---|---|
| `ConversationController.java` | 会话接口入口。处理会话列表、创建会话、删除会话、读取消息。 |
| `ConversationService.java` | 会话和消息的数据库读写逻辑。 |
| `conversation/dto/CreateConversationRequest.java` | 创建会话时的请求数据结构。 |

### 数据源模块 `datasource/`

| 文件 | 作用 |
|---|---|
| `DataSourceController.java` | 数据源接口入口。处理数据源 CRUD、上传 CSV/Excel 建表、授权、读取 schema、推荐问题。 |
| `DataSourceService.java` | 数据源核心业务逻辑。管理数据源、权限、上传表、数据库写入。 |
| `SchemaEnrichmentService.java` | 使用 LLM 或规则补充 schema 描述，让表和字段更适合被 Agent 理解。 |
| `SuggestionService.java` | 根据数据源生成推荐问题。 |
| `FileParsingUtil.java` | CSV/Excel 文件解析工具。 |
| `datasource/dto/*.java` | 数据源接口的数据结构，比如创建数据源、更新数据源、授权用户、字段定义。 |

### 数据库 Schema 模块 `database/`

| 文件 | 作用 |
|---|---|
| `SchemaService.java` | 读取 MySQL 表结构、字段信息、表注释，并做缓存和权限校验。Agent 生成 SQL 前会依赖这里提供的 schema。 |

### LLM 模块 `llm/`

| 文件 | 作用 |
|---|---|
| `LlmService.java` | OpenAI SDK 的封装层。业务代码不直接碰 SDK，而是通过这里发起普通调用或流式调用。 |

### Chat / Agent 模块 `chat/`

| 文件 | 作用 |
|---|---|
| `ChatController.java` | 聊天接口入口。接收用户问题，并用 SSE 流式返回 Agent 过程和结果。 |
| `ChatService.java` | Agent Loop 核心。负责拼 prompt、调用模型、处理 tool call、保存消息、推送流式事件。 |
| `PromptBuilder.java` | 构造发给模型的 prompt，把用户问题、历史消息、schema 等信息组织起来。 |
| `StreamEmitter.java` | SSE 推送封装。把服务端事件持续推给前端。 |
| `SseEvent.java` | SSE 事件的数据结构。 |
| `ChatMessageConverter.java` | 聊天消息格式转换工具。 |
| `TokenEstimator.java` | 粗略估算 token 数，避免 prompt 过长。 |
| `ToolCallDto.java` | 模型 tool call 的数据结构。 |
| `ChatMessageDto.java` | 聊天消息的数据结构。 |
| `chat/dto/ChatRequest.java` | 聊天接口请求体，包含用户消息、会话 ID、数据源 ID。 |

### Chat 子 Agent `chat/agents/`

| 文件 | 作用 |
|---|---|
| `SqlExecutorAgent.java` | SQL 执行 Agent。负责校验 SQL、限制危险语句、执行查询，并尝试修复 SQL 语法问题。 |
| `SemanticDistillerService.java` | 语义蒸馏服务。把查询结果压缩、总结成更适合继续喂给模型的上下文。 |

### Function Calling 工具 `chat/tools/`

| 文件 | 作用 |
|---|---|
| `Tool.java` | 所有工具的统一接口。新增工具时实现它。 |
| `ToolRegistry.java` | 工具注册表。Spring 会自动收集所有 `Tool` 实现，提供给 LLM 使用。 |
| `ToolDefinitions.java` | 定义暴露给模型的 tool schema，也就是模型能看到的函数说明和参数格式。 |
| `ToolContext.java` | 工具执行时需要的上下文，比如当前用户、数据源、SSE 推送器。 |
| `ToolExecutionResult.java` | 工具执行结果的数据结构。 |
| `SqlQueryTool.java` | 查询数据库的工具。模型需要查数据时会调用它。 |
| `AnalyzeResultTool.java` | 分析查询结果的工具。 |
| `GenerateChartTool.java` | 根据数据生成图表配置或图表结果的工具。 |

## 技术栈

| 类别 | 选型 |
|---|---|
| 框架 | Spring Boot 3.5、Spring Security |
| LLM | OpenAI Java SDK (`com.openai:openai-java`) |
| 数据库 | MySQL（JDBC + JdbcTemplate，无 ORM） |
| SQL 安全 | JSqlParser（AST 白名单 + LIMIT 注入） |
| 文件解析 | OpenCSV、Apache POI |
| 认证 | JJWT（JWT 签发/验签）、BCrypt |

## 环境变量

| 变量 | 必填 | 说明 |
|---|---|---|
| `OPENAI_API_KEY` | 是 | LLM API Key |
| `OPENAI_BASE_URL` | 否 | 兼容接口地址（DeepSeek、Qwen 等） |
| `OPENAI_MODEL` | 否 | 模型名称 |
| `DB_HOST` | 是 | MySQL 地址 |
| `DB_PORT` | 否 | MySQL 端口，默认 3306 |
| `DB_USER` | 是 | MySQL 用户名 |
| `DB_PASSWORD` | 是 | MySQL 密码 |
| `DB_NAME` | 否 | 数据库名，默认 `ai_analysis` |
| `JWT_SECRET` | 是 | JWT 签名密钥 |
| `SMTP_HOST` | 否 | 邮件服务地址（密码找回） |
| `SMTP_USER` | 否 | SMTP 发件人 |
| `SMTP_PASS` | 否 | SMTP 密码 |

## 启动

### 本地开发

```bash
# 确保 MySQL 已运行，数据库已通过 pnpm run init-db 初始化

# 在项目根目录 .env 中配置环境变量，然后：
# bootRun 会设置 SPRINGDOTENV_DIRECTORY 指向仓库根，供 spring-dotenv 5.x（springboot3-dotenv）加载 .env。
# 打成的可执行 jar 不含 dotenv；生产环境请用真实环境变量。
cd java-server
./gradlew bootRun
# 服务启动在 http://localhost:3000/api
```

### Docker

```bash
cd java-server
docker build -t gist-agent-java .
docker run -p 3000:3000 --env-file ../.env gist-agent-java
```
