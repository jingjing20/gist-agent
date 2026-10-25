# AgentScope 接入与验证

要求 Node 22.17.0、pnpm 9.15.9。SDK 使用该版本原生 require(ESM) 互操作，Gist 的 CommonJS 编译格式不变。SDK 和 contracts 的本地归档随仓库保存在 vendor/agentscope，完整性由 pnpm-lock.yaml 固定；无需链接另一仓库，安装时保留根 pnpm.overrides。

## 配置

.env.example 默认关闭：

```dotenv
AGENTSCOPE_ENABLED=false
AGENTSCOPE_ENDPOINT=http://127.0.0.1:3100
AGENTSCOPE_API_KEY=
AGENTSCOPE_ENVIRONMENT=gist-development
```

在 AgentScope 创建项目和采集密钥，填入本地 .env 后设置 AGENTSCOPE*ENABLED=true。该密钥仅供服务端，不加 VITE* 前缀，不放入网页、源码或版本库。本次已将本机密钥配置好；关闭只需设为 false 并重启 API/Worker。

当前接入固定 captureContent=false，项目正文也关闭；即使设置同名 capture 环境变量也不会开启。记录步骤类型/状态/时间、模型和实际 usage（提供方有返回时）、TTFT、结束原因及 generation_id，不提交问题、模型回答、SQL/工具输入输出或异常正文。不把估算 Token 当实际用量，流式未提供 usage 时显示未知。原有应用数据库、日志及 LangSmith 策略不因此改变。

## 启动与使用

当前本机两边服务已经运行：Gist 页面 http://localhost:5173，AgentScope 页面 http://localhost:5174，API 分别 3000/3100。Gist 使用原有登录账号，AgentScope 新初始化的本机 admin 凭据保存在 AgentScope 仓库被忽略的 .local/admin-credentials.json（0600）。不要将其提交。

关闭现有进程后重启：先确保 PostgreSQL 5433、Gist Redis 6380、AgentScope Redis 6379 可用；在 Gist 根目录运行 pnpm install --frozen-lockfile、pnpm build、pnpm dev；AgentScope 根目录运行 pnpm db:migrate、pnpm dev。本机依赖首次启动细节见 AgentScope 的 docs/integrations/gist-agent.md。Gist 原有 pnpm dev:local 会管理 Homebrew PG，停止时也可能影响共用该 PG 服务的 AgentScope；两个应用数据库/账号保持独立。

在 Gist 页面正常发起分析后，到 AgentScope 的 gist-agent 项目点击「最近 24 小时」更新窗口，再选择 Trace。根步骤反映实际生成成功/失败/取消；模型流及工具是子步骤，工具返回 succeeded=false 也会标失败。每次后台尝试各有一个 Trace，generation_id 可关联原任务。API 的非流模型调用建立独立 Trace。SIGTERM 停止 Worker 后会尝试有限时 flush；崩溃或断电仍可能丢失内存队列。

## 验证

普通检查不调用模型：

```sh
pnpm typecheck
pnpm build
pnpm --filter @gist/telemetry test
```

真实模型验证必须显式执行（会产生模型费用）：

```sh
node scripts/verify-agentscope.cjs --real-model
```

该脚本运行生产 AnalysisAgent 与 LlmClient，使用合成只读工具 value=42，不访问业务表，不持久化 Gist 对话；关闭 LangSmith 外发，将遥测发往本机 AgentScope。最多 4 次逻辑模型调用、60 秒，输出 Trace ID/调用计数/接收数量，不打印请求、回答或密钥。HTTP 接收不等于 Worker 已投影。

2026-10-25 已执行一次真实验证：1 次合成工具、2 次模型调用、8 个事件接收成功，查询得到 success/complete 和 4 个 Span，所有正文没有 value。Trace ID：30c8a674f152934a48a892caf7be5671；项目 ID：c9e31c9a-6389-4772-be0a-4722c9975a25。此验证不等于真实业务表分析或 GUI 交互验收；页面端到端交互待用户执行。
