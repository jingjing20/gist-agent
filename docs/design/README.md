# 项目设计导航

用途：从产品和架构层理解当前已实现系统；适用读者：产品、架构、全栈开发。实现细节查[guides](../guides/README.md)，技术字段查[reference](../reference/README.md)。

| 文档 | 主要内容 |
| --- | --- |
| [产品概览与功能](product.md) | 用户操作、模块地图、权限和能力边界 |
| [系统整体架构](architecture.md) | Web/API/Worker、共享包、外部依赖、通信及部署 |
| [AI Agent架构](agent.md) | 单循环、模型自主步骤、程序确定性边界、错误与收尾 |
| [数据分析引擎](analysis-engine.md) | SQL安全、结果质量、证据、展示与可信度限制 |
| [知识与上下文](knowledge-and-context.md) | Schema语义、正式Memory、会话/执行/跨轮状态 |
| [前端与API](frontend-api.md) | 页面/Store/内容块、HTTP边界、认证与权限 |
| [数据模型](data-model.md) | 23平台实体的职责、关系、事务与删除 |

内容以[当前工作区基线](../ANALYSIS_PROGRESS.md)为准。未发现或待确认功能不表示未来承诺；没有可靠证据的历史选型见[待确认决策](../decisions/pending-decisions.md)。
