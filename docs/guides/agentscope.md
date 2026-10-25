# AgentScope 本地接入与正文查看

要求 Node 22.17.0、pnpm 9.15.9。CommonJS 通过 Node 原生 require(ESM) 加载同一 SDK 实例。

## 本地源码联调（推荐）

首次在 Gist 根目录运行：

```sh
pnpm agentscope:local /path/to/agent-scope
```

脚本先构建 SDK/contracts，再将 telemetry 的依赖链接到源码目录，并检查真实加载路径。机器路径仅保存在忽略的 `.local/agentscope-link.json`，不提交到版本库；固定包的锁文件保留。此命令只设置链接，不启动服务。

停掉已有的 Gist API/Worker 后运行：

```sh
pnpm dev:agentscope
```

此命令读取上次的本地路径（也可用 `AGENTSCOPE_SOURCE` 指定），构建 Gist API/Worker，监听 SDK/contracts 编译，并在 SDK 产物变化后自动重启 Gist API/Worker。已有 AgentScope API/Worker、PG/Redis 和两边 Web 需另行运行。不要同时运行另一份 Gist API/Worker。Gist 源码更改后仍需重新构建相应包，相关 dist 更新会触发服务重启；此命令主要服务 SDK 联调。停止命令会清理本命令创建的子进程，不停止 PG/Redis。

只监听 SDK、不管理业务进程可用 `pnpm agentscope:local --watch`；此时业务服务需自行重启。`pnpm install` 可能恢复固定包，此后重新运行链接命令。不要把本机路径改入 package.json/锁文件。

## 配置

```dotenv
AGENTSCOPE_ENABLED=true
AGENTSCOPE_CAPTURE_CONTENT=true
AGENTSCOPE_ENDPOINT=http://127.0.0.1:3100
AGENTSCOPE_API_KEY=从项目采集密钥页取得，填写在本机 .env
AGENTSCOPE_ENVIRONMENT=gist-development
```

同时在 AgentScope 项目的「SDK 与采集」开启正文。本机已按用户确认启用双开关。示例配置仍默认关闭，部署时自行决定；密钥仅在服务端，不加 VITE\_ 前缀，不提交 `.env`。

- Agent 根步骤：用户问题、最终回答与显示块、状态；关联 conversation_id、request_message_id、generation_id。
- LLM：实际请求消息、工具定义、非流响应或流式 Assistant 文本/工具调用；提供方实际返回的 usage、结束原因和 TTFT。流式块不预读、不重复消费。
- 工具：所有模型发起的工具步骤，含 finish_analysis 和参数失败；调用 ID、原参数、返回结果和异常。
- 取消/失败保留已收到的流式部分，并记录终态；不会改变业务原返回值或异常。未知用量/费用保持未知，估算值不冒充实际值。

SDK 过滤敏感对象键，并脱敏文本中的 Bearer、显式 api_key/password、常见模型密钥和数据库连接 URI；自然语言中的个人/业务敏感内容仍可能被采集。每个正文字段上限 32 KiB，流式结构使用更小的有界缓冲；超限明确标记截断，结构无法安全保存时显示摘要。旧记录无法补采，关闭也不删除已存正文。应用原日志和 LangSmith 策略独立。

## 查看与验证

Gist 页面正常发起任务后，在 AgentScope 的 gist-agent 项目点击「最近 24 小时」，从输入/输出预览进入执行；可用对话 ID 筛选同一对话的多轮记录。左侧选择 Agent、模型或工具，右侧查看输入/输出/消息/异常/元数据。模型输入按角色展示消息并列出可用工具，支持折叠、复制和原始 JSON。列表只拉取最长 512 字符预览，详细正文按需加载。

快速检查：

```sh
pnpm build
pnpm typecheck
pnpm test:agentscope
```

可选 `node scripts/verify-agentscope.cjs --real-model` 会使用真实配置调用模型，最多四轮/60 秒；只执行合成工具，不读取业务表，不创建 Gist 对话。实际页面对话验收另记在 AgentScope 的 `docs/integrations/conversation-tracing.md`。不要将合成检查等同于业务 SQL 验收。

固定部署包仍保存在 `vendor/agentscope`，随此次能力更新；在没有另一仓库的机器上可以正常构建。正式发布后宜改用固定版本的包仓库依赖。
