# ADR-001：对Agent SQL使用AST白名单校验

## 状态与日期

现状有效；2026-10-14逆向记录。原始决策日期、批准人和评审过程待确认。此记录只确认可证的设计理由及当前行为。

## 背景和决策

Agent提交SQL字符串，需要在执行前确认只读及授权范围。当前SqlExecutor采用node-sql-parser PostgreSQL AST做单SELECT、递归表作用域和字段政策校验，再在只读PG事务中执行。

## 可证的原因

[SqlExecutor.validate](../../apps/worker/src/chat/tools/sql-executor.ts)注释明确写道：“为什么用 AST 而不是正则：正则无法处理子查询、CTE、注释注入等绕过手段”。已读取`ce5dbfb`中旧位置`apps/worker/src/chat/agents/sql-executor.ts`的同一注释，证明这一理由在当前未提交文件迁移前已有。

该证据支持AST相对仅用正则的选择；不支持声称曾比较特定其他SQL解析库或拥有正式安全评审结论。

## 备选与权衡

有证据的对照仅“只用正则”。没有证据还原其他备选、性能测试或技术选型会议。当前可观察代价：Parser不能识别的PostgreSQL语法会在执行前被拒绝，sqlify会改写输出；mask限制为普通直接SELECT，减少可表达的查询形式。

AST并非SQL业务语义验证器；实际安全也依赖只读账号、事务、目录和字段策略。现有危险函数名单不是全部数据库函数的安全证明。

## 关联

[分析引擎设计](../design/analysis-engine.md)、[SQL实现指南](../guides/sql-and-artifacts.md)、[现状问题](../guides/risks-and-open-questions.md)。
