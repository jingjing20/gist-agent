# 待确认的架构决策证据

用途：保存重大选择的当前事实与尚缺的历史说明；本文件不是已批准ADR。适用读者：架构维护者。

| 主题 | 当前已确认事实及来源 | 无法证明的历史内容 |
| --- | --- | --- |
| 单Agent原生Tool Calling | [AnalysisAgent](../../apps/worker/src/analysis/analysis-agent.ts)；`de269aa`历史源码有“one decision loop”边界注释 | 为何选单Agent、曾否比较多Agent/框架、适用规模 |
| API/Worker分离与BullMQ | [ChatService](../../apps/api/src/chat/chat.service.ts)、[Worker](../../apps/worker/src/chat/generation-worker.service.ts) | 分离动机的量化指标、其他队列评估 |
| Outbox与持久事件 | [generation-events](../../packages/database/src/generation-events.ts)、[Relay](../../apps/api/src/chat/outbox-relay.service.ts) | 原始投递一致性要求、历史Redis直接发布迁移原因 |
| PostgreSQL和单库逻辑源 | [DatabaseClient](../../packages/database/src/index.ts)、[Schema](../../packages/database/src/schema.ts) | 选PG的历史理由、是否计划物理分源 |
| 自由文本数据源Memory | [MemoryRepository](../../packages/database/src/memory-repository.ts)；`4c6d25e`代码历史可定位引入 | 为何替代结构化business_definition、如何评估冲突处理 |
| 证据驱动图表 | [GenerateChartTool](../../apps/worker/src/chat/tools/generate-chart.tool.ts) | 初始验收目标和曾评估方案；当前可观测约束已在设计/指南说明 |
| Vue/reka-ui/主题 | [web package](../../apps/web/package.json)、[MainLayout](../../apps/web/src/views/MainLayout.vue) | 前端选型的历史取舍；不据提交标题编造原因 |

需要维护者补充真实业务约束、原始讨论/评审记录及方案比较后，才能写历史理由或正式批准状态。现有代码可以说明设计作用，作用与历史选择原因必须分开表达。
