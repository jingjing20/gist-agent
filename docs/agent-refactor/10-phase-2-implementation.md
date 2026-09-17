# Phase 2 决策与实施记录：确定性编排

> 实施日期：2026-09-17
>
> 状态：已完成；空响应失败语义和完整 Agent Loop mock 集成测试已通过
>
> 对应问题域：[编排与提示词](./02-orchestration-and-prompts.md)

## 1. 阶段结论

Phase 2 把工具参数、调用顺序和循环出口从“模型应该遵守的提示”升级为“服务端必须验证的执行契约”。模型仍负责理解、规划和表达，但不再拥有改变工具工作流状态、绕过工具前置条件或把空响应伪装成成功的最终权限。

## 2. 重构前为什么不够可靠

### 2.1 Prompt 被当成控制系统

原流程用 Prompt 和 tool description 告诉模型依次调用 `execute_sql_query -> analyze_result -> generate_chart`。这些文本能提高模型遵守概率，却不能形成安全边界；模型可以跳步、重复、乱序或在同一批发出相互依赖的调用。

### 2.2 Function Calling schema 被误当成运行时校验

模型返回的 arguments 本质上是不可信字符串。原实现 JSON 解析失败后用空对象继续执行，工具层也缺少完整的必填、类型和跨字段校验，因此空 SQL 或轴/序列不一致的图表可能进入副作用层。

### 2.3 并行执行忽略依赖

同一轮所有 tool calls 使用 `Promise.all`。即使数组顺序是“先查询、后画图”，两个动作仍同时启动；图表无法真正依赖尚未返回的查询证据。

### 2.4 退出路径语义不完整

达到最大循环次数后函数自然返回，外层可能把“只有工具调用、没有最终回答”的 generation 标成 completed。监控和用户看到的成功状态并不代表任务完成。

### 2.5 `analyze_result` 与 raw reasoning 的产品问题

- `analyze_result` 不读取或计算查询结果，只回显模型自己给出的 `needsChart`，增加一次循环和失败点，却没有增加证据。
- 原始 `reasoning_content` 被当作 SSE 产品协议和 UI 内容；它可能不完整、包含敏感上下文，并受不同模型供应商私有格式影响。

### 2.6 根因

系统没有明确区分两个角色：模型只能提出候选动作，编排器才有权验证并执行动作。模型输出跨过了信任边界，直接成为控制流和工具输入。

## 3. 方案选择与取舍

### 3.1 采用轻量显式编排器，而非引入大型 Agent 框架

当前只有少量工具和清晰的不变量。引入通用框架会扩大迁移面，并不自动解决本项目的 writer guard、generation terminal 和数据证据问题。`AgentOrchestrator` 以最小改动建立状态与校验边界，后续仍可演进为更完整的 interpreter/planner/synthesizer。

### 3.2 运行时校验放在工具接口，而非只加强 Prompt

Prompt 和 Function Calling schema继续帮助模型生成正确参数，但服务端 `parseArguments` 是最后的可信边界。这样即使更换模型、供应商协议异常或发生截断，非法输入也会在副作用前失败。

### 3.3 当前全部工具串行，而非保留自动并行

工具尚未声明独立性、幂等性和并行安全，因此默认串行是可证明的选择。未来只有显式标记为互不依赖的只读工具才能并行；不能从“看起来都是工具调用”推导安全并发。

### 3.4 下线 `analyze_result`，而非继续包装它

一个不消费真实数据、只接受模型判断的“工具”没有独立事实价值。当前由工作流和 Prompt 决定是否画图；Phase 3 再让 Chart Artifact 直接引用 Query Artifact，建立真正的数据依赖。

### 3.5 隐藏 raw reasoning，但保留内部协议兼容

新 Worker 不发送 reasoning SSE，也不写 UI block；Web 忽略历史 reasoning event/block。供应商要求回传 reasoning 上下文时，内部 LLM message 仍可保留它。这样切断产品展示，又不破坏模型协议。

## 4. 最终设计与不变量

### 4.1 显式状态

当前第一版状态链路是：

```text
UNDERSTANDING
  -> COMPLETED                         # 直接文字回答
  -> QUERYING
  -> RESULT_VALIDATION
       -> QUERYING                     # 追加/修正查询
  -> CHART_PLANNING?
  -> SYNTHESIZING
       -> QUERYING | CHART_PLANNING    # 继续分析
  -> COMPLETED

非法动作 -> FAILED
迭代耗尽 -> FAILED / MAX_AGENT_ITERATIONS_EXCEEDED
```

它没有假装一次性完成最终目标状态机中的所有职责，而是先覆盖现有工具循环真正能够执行和测试的状态。

### 4.2 运行时工具校验

- arguments 必须是合法 JSON object。
- SQL 的 `title`、`sql` 必须为非空字符串。
- chart type 必须在允许集合中。
- `xAxis`、`series` 必须为非空数组。
- series name 必须非空，数据必须是有限数值。
- 每个 series 的长度必须与 `xAxis` 一致。
- 非法输入统一以 `INVALID_TOOL_ARGUMENTS` 在工具副作用前失败。

### 4.3 状态和批次约束

- `generate_chart` 只能使用前一模型迭代已经完成且成功的查询结果。
- 同一批次里的 query 不能作为同批 chart 的证据，因为模型发出 chart 时尚未观察查询结果。
- 查询失败不会解锁 chart。
- 未注册、已下线或当前状态不允许的工具以 `INVALID_STATE_TRANSITION` 失败。
- 当前工具调用顺序执行，不再用 `Promise.all` 隐式并发。

### 4.4 明确 outcome

- 无工具调用的正常回答返回 `{ kind: 'completed', state: 'COMPLETED' }`。
- 无可展示文本且无工具调用（包括 empty stream、空白文本和 reasoning-only）抛出 `EMPTY_LLM_RESPONSE`。
- 达到最大轮次抛出 `MAX_AGENT_ITERATIONS_EXCEEDED`。
- LLM 建连/流读取失败归一为 `LLM_REQUEST_FAILED`，工具抛错归一为 `TOOL_EXECUTION_FAILED`。
- 非法状态和参数使用稳定机器错误码。
- 循环边界只有一种失败表达：成功返回 `AgentOutcome`；失败抛 `GenerationExecutionError`，由 generation 外层统一写入 failed/cancelled 终态。`AgentOutcome.failed` 已移除，避免返回值和异常双重语义。

### 4.5 版本变更

会改变模型决策或工具契约的版本已提升：

- `prompt-policy-v2`
- `toolset-v2`

## 5. 重构前后对比

| 场景             | 重构前                 | 重构后                                       | 为什么更好                   |
| ---------------- | ---------------------- | -------------------------------------------- | ---------------------------- |
| 非法 JSON        | 解析失败后以 `{}` 继续 | `INVALID_TOOL_ARGUMENTS`，不执行工具         | 不可信输入无法进入副作用层   |
| 空 SQL/错误图表  | 主要依赖模型 schema    | 服务端类型和跨字段校验                       | 更换模型也不降低底线         |
| 工具顺序         | Prompt 建议            | Orchestrator 按状态拒绝                      | 流程不变量可以单元测试       |
| 同批依赖工具     | `Promise.all` 同时启动 | 默认串行，且 query/chart 跨迭代              | 模型必须先观察数据再画图     |
| 查询失败后画图   | 可能继续               | 失败查询不产生 chart 前置证据                | 避免基于不存在的数据生成图表 |
| 空/仅推理响应    | 可能被记为 completed   | `EMPTY_LLM_RESPONSE`                         | 成功终态必须有用户可见结果   |
| LLM/工具抛错     | 可能落入泛化内部错误   | `LLM_REQUEST_FAILED`/`TOOL_EXECUTION_FAILED` | 失败来源可观测、可聚合       |
| 迭代耗尽         | 可能被记为 completed   | 明确失败码                                   | 终态语义与用户结果一致       |
| `analyze_result` | 增加一次无证据循环     | 不再注册                                     | 降低延迟和无效失败面         |
| raw reasoning    | SSE、block 和 UI 展示  | 仅在内部协议需要时保留                       | 降低泄露和供应商耦合风险     |

收益来自“权限重新分配”：模型擅长提出语义动作，代码擅长保证结构、顺序和终态。把二者分开后，模型输出波动不再直接等于系统控制流波动。

## 6. 验证如何证明这些收益

新增：

```bash
pnpm test:phase2-orchestration
```

专项命令同时运行 Orchestrator 契约回归和 `ChatService.runAgentLoop` mock 集成测试，覆盖：

- malformed JSON 在执行前拒绝；
- 空 SQL 在执行前拒绝；
- 未查询直接画图被拒绝；
- 已下线 `analyze_result` 被拒绝；
- 查询失败后画图被拒绝；
- query、chart 和 complete 的合法状态转换；
- chart 轴/序列长度不一致被拒绝；
- 直接文字回答、空 stream、reasoning-only 与空白回答；
- 流式 tool call arguments 分片拼接；
- 单次/多次查询、查询失败后重试、成功查询后画图；
- 非法工具参数在完整循环内被拒绝；
- LLM 建连失败、流中断、工具抛错和取消的稳定错误码；
- 15 轮迭代耗尽；
- 空响应经过 `runGeneration` 后最终写入 `failed / EMPTY_LLM_RESPONSE`，terminal 与 block 使用同一错误码。

完整验证结果：

- `pnpm typecheck`：通过
- `pnpm build`：通过；仅有既存 Vite chunk size 警告
- `pnpm test:generation-baseline`：通过
- `pnpm test:reasoning`：通过
- `pnpm test:phase1-reliability`：10 类可靠性/故障场景通过
- `pnpm test:phase2-orchestration`：通过
- `pnpm --filter @gist/api test:init-db`：1/1 通过
- `pnpm benchmark:analytics`：40 个 SQL case、6 个语义 case 通过
- 隔离 `LLM_PROVIDER=mock` API/Worker 的 `pnpm smoke:conversation`：2/2 generation completed

环境说明：部分本机网络/IPC 测试首次在沙箱内因 `EPERM` 失败，获准后通过。连接当前常驻外部模型 Worker 的 smoke 连续两次超过脚本固定的 15 秒等待窗；数据库未留下 active generation。为排除常驻多 Worker 与外部模型延迟，使用独立 API 端口和 Redis DB 的 mock Worker 重跑同一 smoke，2/2 通过。因此 Phase 2 的确定性测试已通过，但这两次外部模型运行不记为成功证据。

## 7. 兼容与回滚

- 无数据库迁移。
- SSE 类型暂时保留旧 reasoning 类型，用于反序列化历史事件；新 Worker 不再产生，Web 不再展示。
- `AnalyzeResultTool` 源文件暂时保留但不注册，短期回滚只需恢复 provider 注册和 Prompt；长期应在 Phase 3 稳定后删除死代码。
- 新错误码是增量协议；旧客户端仍可使用用户可读 `error`，新客户端可按 `errorCode` 精确处理。

## 8. 边界与遗留问题

Phase 2 解决的是控制流可信，不等于分析证据已经可信：

- chart 数组仍由模型从查询结果转录；当前只能保证它发生在成功查询后，不能证明每个数值来自哪个结果字段。
- 尚未持久化 Query/Chart Artifact，跨轮追问仍可能只剩脱水历史。
- 当前状态机是围绕已有 ReAct loop 的第一版，没有独立的结构化 QuestionInterpreter、QueryPlanner 和 AnswerSynthesizer。
- Prompt 尚未完全拆成独立、可快照的安全/分析/工作流层。
- 工具校验为手写等价校验；工具数量扩大后可评估统一 schema validator，避免定义与运行时规则漂移。
- `AnalyzeResultTool` 文件和旧 Thinking 组件仍是兼容期死代码，需要后续清理。

## 9. 下一阶段为什么是 Phase 3

> 后续状态：Phase 3 已完成，详见 [Phase 3 实施记录](./12-phase-3-implementation.md)。本节保留 Phase 2 收口时的决策背景。

现在系统能保证“动作合法并按顺序执行”，但还不能保证“回答、表格和图表引用的是同一份可追溯证据”。Phase 3 应引入 Turn、Query Artifact 和 Chart Artifact，让状态机的 `RESULT_VALIDATION` 真正绑定结构化结果，并消除模型复制图表数值的最后一段漂移风险。
