# 开发者理解指南

用途：通过业务场景、关键对象和正常/异常流程掌握真实实现，并定位后续修改范围。适用读者：开发者与AI Coding。先读[设计导航](../design/README.md)建立功能地图。

指南中的示例ID、文件和结果均标明教学构造，不是线上样本或本次运行验收。核心字段含义集中在[数据模型](../design/data-model.md)，完整类型/列清单继续查[reference](../reference/README.md)，避免手工维护第二份Schema。

## 按阅读目标选择

| 文档 | 读完应能解释什么 |
| --- | --- |
| [开发环境与代码导航](development.md) | 三应用与依赖为什么都要准备；账号、改密、重置、会话删除如何运行 |
| [Generation生命周期](generation-lifecycle.md) | 202如何到Worker；幂等、容量、writer、心跳、超时、取消、完成事务各起什么作用 |
| [Agent Loop](agent-loop.md) | 模型具体看到什么；tool碎片如何组装；展示、结论、finish和错误修正如何决策 |
| [SQL与Artifact](sql-and-artifacts.md) | 查询怎样授权/校验/执行/脱敏；同份结果如何变成模型输入、存储证据、表格和图表 |
| [上下文与状态](context-and-state.md) | 追问怎样继承条件；版本、任务、Memory引用、预算和证据适用性怎样变化 |
| [数据库持久化链路](database-persistence.md) | 一轮分析在各表写入什么；事务边界与失败/取消/删除后哪些信息仍存在 |
| [业务Memory](memory.md) | 直存和候选为何不同；确认、替换、冲突、软删除与固定快照如何协作 |
| [数据源与Schema](datasource-and-schema.md) | 文件怎样变成物理表与目录；授权与字段政策如何生效；注释建议怎样经审核保存 |
| [前端流式协作](frontend-streaming.md) | 两类游标、跳号补洞/快照、done刷新与文字播放怎样协作；结果和依据怎样读取 |
| [问题与排查](risks-and-open-questions.md) | 按标识和持久层定位断点，区分当前限制、影响推断和待确认政策 |

## 两条推荐阅读路线

理解一次完整分析：开发环境 → Generation → Agent Loop → SQL/Artifact → 前端流式 → 数据库持久化。这样先看到功能怎样工作，再看它在哪些表留下记录。

理解口径与追问：数据源/Schema → Memory → 上下文/状态 → SQL/Artifact → 数据模型。这样可以区分正式知识、本轮临时条件、已提交状态和历史证据。

已有设计问题与尚未验证的运行表现统一见[问题记录](risks-and-open-questions.md)。每篇“修改入口”指出需要同时核对的层；不要把单文件类型通过当作全链路行为正确。

本次不运行浏览器E2E、GUI、真实外部服务或完整回归。文档命令/SQL示意只供后续开发者按环境与授权使用，不能当作已执行结果。
