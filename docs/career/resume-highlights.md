# Gist Agent 项目亮点

本文用于描述当前实现，不代表已经完成真实业务验收。验证状态以[交付页](../agent-refactor/05-delivery-and-validation.md)为准；历史实现不再作为当前亮点。

## 简历描述参考

基于 Vue 3、NestJS、PostgreSQL 和 BullMQ / Redis 构建自然语言数据分析 Agent，支持文件上传、业务定义管理、多轮分析、可追溯查询证据及图表展示。模型通过工具自主选择分析路径，代码负责权限、执行预算、状态一致性与取消边界。

可按岗位选择以下内容，避免整段堆砌：

- 实现单 Agent 工具循环与结构化提交协议，将 SQL 修正放回主循环；校验工具参数、证据引用和预算退出，区分完整答案、部分答案、澄清与拒绝。
- 将数据源级业务定义、会话分析状态和查询 Artifact 分开建模；业务定义由用户确认并保存版本，临时口径不自动进入长期知识。
- 通过条件签名与查询快照约束多轮证据复用，筛选或口径变化后检查适用性；图表引用查询结果，避免模型复制数值。
- 在 API / Worker 分离架构下处理任务调度、取消和终态写保护，前端按会话及 generation 归属流事件；交互行为仍需按验收清单确认。
- 实现按优先级选择上下文和完整工具交互，输出选择报告，保留当前任务及必要依据；超预算时明确失败或部分收尾。

## 讲述时应准备的证据

| 亮点 | 代码入口 | 可展示内容 |
| --- | --- | --- |
| 受控循环 | [AnalysisAgent](../../apps/worker/src/analysis/analysis-agent.ts) | SQL 错误反馈、修改、预算及提交校验 |
| 数据源记忆 | [记忆仓库](../../packages/database/src/memory-repository.ts) | 候选确认、版本冲突、记忆变化 |
| 多轮连续性 | [状态校验](../../apps/worker/src/analysis/analysis-state.ts) | 条件变化重查与匹配证据复用 |
| 上下文选择 | [ContextAssembler](../../apps/worker/src/analysis/context-assembler.ts) | 相同输入的选择报告和 tool-call 配对 |
| 后台执行 | [Worker ChatService](../../apps/worker/src/chat/chat.service.ts) | 执行与订阅分离、取消与终态边界 |

## 表述边界

只陈述自己实际完成并能解释的部分。没有对照数据时不写“准确率提升”“节省多少 Token”“提速数十倍”或“支持千万级数据”；没有验收证据时不写“工业级”“生产级”或“彻底消除幻觉”。

当前不使用旧三级记忆、后台语义蒸馏、SQL 子 Agent 静默修复或 MySQL LOAD DATA。技术栈也不包含旧材料宣称的 TypeORM、NuxtUI 等依赖。Schema 自动注释是推断线索，不能表述为自动获得真实业务语义。

[面试参考](agent-interview.md) · [设计入口](../agent-refactor/README.md)
