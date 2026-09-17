# Phase 2 实施记录

## 1. 范围

本阶段完成 ORC-01、ORC-02 和 ORC-03，把工具顺序、参数合法性和 Agent 终态从 Prompt 约定迁移为服务端可测试的不变量。

## 2. 实现

- 新增 `AgentOrchestrator`，显式维护 `UNDERSTANDING -> QUERYING -> RESULT_VALIDATION -> CHART_PLANNING -> SYNTHESIZING -> COMPLETED`，非法转换进入 `FAILED`。
- Agent 正常文本退出返回 `completed` outcome；达到循环上限抛出 `MAX_AGENT_ITERATIONS_EXCEEDED`，不再误记为成功。
- 工具在执行前解析 JSON 并进行运行时校验。非法 JSON、空 SQL、非法图表类型、空数组、非有限数值和轴/序列长度不一致都会在副作用前以 `INVALID_TOOL_ARGUMENTS` 拒绝。
- 当前工具未声明并行安全，因此同批工具调用按顺序执行。图表必须基于此前迭代已经完成的查询；同一批中的查询不能作为图表证据。
- `analyze_result` 从注册工具集下线。图表决策直接由受控工作流处理，减少一个无数据输入的模型循环。
- Worker 不再发送或写入 UI block 的原始 `reasoning_content`；Web 同时忽略历史 reasoning 事件和 block。供应商协议需要时，reasoning 仍只保留在内部 LLM message context。
- Agent 版本提升为 `prompt-policy-v2` / `toolset-v2`；新增稳定错误码 `INVALID_TOOL_ARGUMENTS` 和 `INVALID_STATE_TRANSITION`。

## 3. 兼容与回滚

- 数据库无迁移。
- SSE 类型暂时保留旧 reasoning 类型，便于旧事件反序列化，但新 Worker 不再产生，Web 不再展示。
- `AnalyzeResultTool` 源文件暂时保留但不注册，便于短期回滚；旧模型若仍调用会得到确定性的非法状态错误。

## 4. 自动化验证

- `pnpm typecheck`
- `pnpm build`
- `pnpm test:generation-baseline`
- `pnpm test:reasoning`
- `pnpm test:phase1-reliability`
- `pnpm test:phase2-orchestration`
- `pnpm benchmark:analytics`
- `pnpm smoke:conversation`

其中最后三项依赖本地 PostgreSQL、Redis、API、Worker 和已配置模型；执行结果应记录在交付说明中。
