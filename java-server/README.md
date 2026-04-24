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
