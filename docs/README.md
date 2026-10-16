# Gist Agent 项目文档

用途：从当前源码理解产品全貌与关键实现，并为持续迭代提供可追溯知识。适用读者：产品、架构、全栈、Agent开发者及AI Coding。

本套文档基于 **2026-10-14当前工作区（HEAD ce5dbfb，含已有未提交修改）**，只描述已落地实现。未恢复旧文档，未修改业务代码或配置。事实等级与分析基线见[ANALYSIS_PROGRESS](ANALYSIS_PROGRESS.md)。

## 项目总体理解

Gist Agent让用户上传CSV/Excel并通过自然语言分析已授权数据。Vue前端与NestJS API管理账号、会话、数据源和知识；独立BullMQ Worker运行单Agent工具决策循环，查询同一PostgreSQL中的目录表，保存SQL及结果证据，再流式交付正文/表格/图表。长期知识按数据源管理，跨轮分析条件按会话保存；失败草稿与已提交状态分开。

系统具备较明确的执行、权限、证据和状态边界，但结论和SQL业务语义仍主要由模型判断，不能把流程状态当作自动正确性证明。问题、推断和运行待确认范围集中于[问题记录](guides/risks-and-open-questions.md)。

## 完整索引

| 目录/文件 | 回答的问题 | 文档 |
| --- | --- | --- |
| [design](design/README.md) | 项目是什么、有哪些能力、整体如何设计 | 产品、系统架构、Agent、分析引擎、知识/上下文、前端/API、数据模型 |
| [guides](guides/README.md) | 代码怎么工作、修改和排查哪里开始 | 环境、Agent Loop、任务生命周期、SQL/Artifact、状态、数据库持久化、Memory、Schema、前端流、问题 |
| [decisions](decisions/README.md) | 哪些重要理由有证据，哪些待确认 | AST校验、草稿共同提交、待确认选择 |
| [reference](reference/README.md) | 接口、表、工具分别做什么，定义怎么查 | 路由/DDL与用途注释合并参考、工具场景与契约、配置、生成器 |
| [ANALYSIS_PROGRESS](ANALYSIS_PROGRESS.md) | 分析覆盖、证据和后续恢复 | 阶段、模块地图、确认结论、待确认范围 |
| [VALIDATION](VALIDATION.md) | 文档完成了哪些核验 | 链接/图/生成参考/写入边界及运行限制 |
| [verify.py](verify.py) | 如何重复文档快速检查 | 只读链接/导航/图结构/敏感模式检查 |

## 推荐阅读顺序

1. [产品概览](design/product.md) → [整体架构](design/architecture.md)，建立功能地图和进程边界。
2. [Agent架构](design/agent.md) → [分析引擎](design/analysis-engine.md) → [知识上下文](design/knowledge-and-context.md)，理解决策、查询与口径。
3. [前端/API](design/frontend-api.md) → [数据库](design/data-model.md)，掌握交付、实体关系和关键字段语义，再读[数据库持久化](guides/database-persistence.md)跟踪一轮分析的实际写入。
4. [开发入口](guides/development.md) → [Generation生命周期](guides/generation-lifecycle.md) → [Agent Loop](guides/agent-loop.md) → [SQL与证据](guides/sql-and-artifacts.md)，追踪端到端实现。
5. 按修改领域读[状态](guides/context-and-state.md)、[Memory](guides/memory.md)、[Schema](guides/datasource-and-schema.md)、[前端](guides/frontend-streaming.md)。查字段用reference，查原因用decisions，排查先读[问题记录](guides/risks-and-open-questions.md)。

## 证据与维护原则

- 已确认：直接源码/Schema/配置/调用关系。推断：对作用或用户的合理解释。待确认：线上状态、历史原因或业务要求证据不足。静态事实与运行验证分开。
- 设计说明职责和关系；指南记录运行机制；参考定义优先以源码为主；ADR只写有依据的原因。交叉链接代替重复维护完整代码/类型。
- 每次功能变更同步主要文档：页面/API或权限改产品和前后端设计；工具/Prompt/state改Agent和相应指南；Schema改数据模型并重生成reference；真实架构决策补ADR。
- AI Coding先读索引、进度和领域文档，再读对应源码；若文档与源码冲突，核对源码并记录修订，不能把旧文档当新实现指令。
- 参考重生成：`python3 docs/reference/generate.py`；检查：`python3 docs/reference/generate.py --check`、`python3 docs/verify.py`。新增/删除接口或平台表同时维护reference用途JSON；已有实现行为变化仍需人工核对用途，不以生成一致代替语义检查。两者无需数据库或外部服务。
- 新规划单独标“未实现”，不得混进As-Is。后续会话从ANALYSIS_PROGRESS恢复，记录新增证据、未解决项和验证结果。

根README当前已有部分链接指向另一套不存在的docs文件，本次遵守只写docs范围未修改根README；请以本索引为阅读入口，维护者之后可将根索引切换到docs/README.md。


## 第二轮深化后的阅读方式

本轮重点补齐开发者讲解深度：核心指南按用户场景、关键对象、状态变化和失败分支展开；数据库设计解释关键字段的业务用途及读写方，[持久化指南](guides/database-persistence.md)用同一轮分析串联各表。

如果希望先检查文档是否真正讲清功能，建议选一个具体问题：

- “为什么工具已经展示图表，还不能完成回答？”读[Agent Loop](guides/agent-loop.md)的收尾状态。
- “明明查到了行，为什么不能据此画图或得出总体结论？”读[SQL/Artifact](guides/sql-and-artifacts.md)的质量和数据变化。
- “浏览器收到第12条却缺第11条事件怎么办？”读[前端协作](guides/frontend-streaming.md)的补洞示例。
- “取消之后哪些数据保留、哪些状态不会传给下一轮？”读[持久化](guides/database-persistence.md)与[状态](guides/context-and-state.md)。

教学片段是缩小后的真实契约形状，标识/行值为构造数据；真实函数、字段、条件和事务以链接源码为证据。第二轮完成和验证范围记录于[分析进度](ANALYSIS_PROGRESS.md)。
