# Phase 6：规模化优化实施记录

> 状态：实现完成（2026-09-18）

## 1. 原有问题

Phase 3 只建立了 Schema 目录与详情契约，运行时仍把全部可见表字段注入 Prompt。表数量增大后，输入 token 与构建延迟随 Schema 线性增长。另一方面，generation 虽记录模型与策略版本，却没有逐次 token、成本、工具调用和 Schema 选择指标；现有 benchmark 只验证参考 SQL，不能作为真实 Agent 的发布门槛。Artifact、持久事件和记忆也只有零散的 `expires_at` 字段，没有统一执行与审计。

## 2. 关键决策

1. 目录仍是授权边界，检索只能在已授权目录内排序，不能通过召回扩大权限。
2. 20 张表以内保留完整 Schema，超过后先对目录做确定性词法排序，再加载 Top 12 字段详情。检索失败时不猜表名，SQL Guard 仍执行最终 fail-closed 校验。
3. token 使用字符估算并明确标记为 estimated；价格由 `LLM_INPUT_COST_PER_MILLION_USD` 和 `LLM_OUTPUT_COST_PER_MILLION_USD` 注入，不把供应商价格硬编码进代码。
4. 普通请求与 reasoning 请求分别使用 `OPENAI_FAST_MODEL` 和 `OPENAI_REASONING_MODEL`，最终模型名固化在 generation。仅在流尚未建立时做最多三次有界重试，禁止在收到 delta 后自动重放。
5. 保留策略使用数据库表配置，Worker 周期执行，且每种资源独立写入成功/失败审计；默认 Query Artifact 和持久事件 30 天、记忆 365 天。

## 3. 已交付能力

- `SchemaService` 提供百表目录排序、Top-K 详情加载、查询级缓存和 Schema 候选数/选择数/token/延迟指标。
- `generation_metric` 保存 LLM、工具、SQL 调用数，估算输入/输出 token、成本和 Schema 检索指标。
- `generation_trace_span` 保存不含敏感原文的阶段耗时和状态；`GET /operations/generations/:id/trace` 仅允许 generation 所属用户读取。
- `agent_evaluation_run` 保存发布评测汇总；`GET /operations/dashboard?days=7` 按模型及五类策略版本聚合成功率、错误终态、P95 总延迟/首 token、token、成本、工具次数和最近质量评测。
- `retention_policy`、`retention_cleanup_audit` 和 `RetentionService` 形成可配置、可执行、可审计的清理闭环。
- `evaluate:phase6` 通过真实 API/Worker 逐 case 执行 SaaS Growth benchmark，保存逐 case 证据与机器可读 JSON，并按正确率、Schema 召回、P95 延迟和平均成本返回发布门禁退出码。
- `test:phase6-worker-kill` 提供真实 Worker `SIGKILL`、替代 Worker 接管监控、`WORKER_LOST` 终态和旧 writer 清除的发布级 E2E 场景。

## 4. 配置与回滚

- `SCHEMA_RETRIEVAL_LIMIT`：大目录字段详情上限，默认 12。
- `OPENAI_FAST_MODEL` / `OPENAI_REASONING_MODEL`：模型路由；未配置时回退 `OPENAI_MODEL`。
- `LLM_REQUEST_MAX_ATTEMPTS`：建流前最大请求次数，默认 2、最大 3。
- `RETENTION_CLEANUP_ENABLED=0`：停止自动清理；已写审计不会删除。
- `RETENTION_CLEANUP_INTERVAL_MS`：清理周期，默认 24 小时，最小 1 分钟。

回滚应用代码不会丢失旧 generation；新增表可保留供审计。若需停用行为，先关闭清理器并取消模型路由环境变量。不要先删除指标或审计表。

## 5. 验证证据

- `pnpm typecheck`：通过。
- `pnpm build`：通过。
- `pnpm test:phase6`：通过；100 张表中目标表排名第 1、详情上限 12、排序低于 100ms，评测打分与三类清理审计契约通过。
- `pnpm init-db`：通过；本地 PostgreSQL 已存在 `generation_metric`、`generation_trace_span`、`retention_policy`、`retention_cleanup_audit`。

按仓库测试约定，本次没有主动运行真实模型全量评测或 Worker kill E2E；它们需要已启动的 API/Redis/Worker 或真实模型额度，作为发布环境验收命令保留。

## 6. 仍需持续运营的事项

Phase 6 完成的是“可测、可控、可迭代”的规模化闭环，不代表模型质量永久完成。每次模型、Prompt、工具或检索策略变更仍必须运行 `evaluate:phase6`，人工审核标准答案变更，并根据线上 dashboard 调整阈值。向量/Embedding 检索只有在词法召回报告证明不足后再引入。
