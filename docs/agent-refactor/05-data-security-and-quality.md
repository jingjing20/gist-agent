# 05. 数据安全与分析质量改造

> 规划状态：对应 Phase 4，尚未完整实施。Phase 1 已完成单次 SQL 的只读事务、`statement_timeout` 和后端取消，但独立最小权限角色、全面 fail-closed、敏感字段策略与 ResultQuality 仍未完成。
>
> 前置依赖：Phase 3 的 Query Artifact 为质量摘要和证据审计提供稳定载体；安全底线中不依赖 Artifact 的部分可以提前实施。

## 1. 目标

让“SQL 可执行”升级为“权限正确、成本可控、口径可信、结论有证据”。安全与分析正确性必须由多层机制保证，不能依赖模型遵守提示词。

## 2. 当前实现证据

- SQL 使用 `node-sql-parser` 的 PostgreSQL 模式解析，只允许 select/show/desc/describe/explain。
- 通过 catalog 获取允许表，并使用 `tableList` 校验表名。
- `tableList` 发生非安全类异常时会忽略并继续执行：`apps/worker/src/chat/agents/sql-executor.ts`。
- 无 LIMIT 的 SELECT 被注入 1000 行。
- SQL 执行和应用元数据使用同一个数据库客户端/连接配置：`packages/database/src/index.ts`。
- Schema 注释包含 LLM 根据前 5 行样本生成的自由文本：`apps/api/src/datasource/schema-enrichment.service.ts`。
- Query Tool 会把最多约 60,000 字符的结果交给主模型。

## 3. 安全问题

### SEC-001：表范围验证存在 fail-open 路径（P0）

表名解析异常不应被忽略。无法证明查询只访问允许表时必须拒绝执行。

### SEC-002：AST 是主要边界，缺少数据库最小权限兜底（P0）

解析器存在方言边界和未知语法。应用连接一旦拥有写元数据权限，AST 绕过的影响会扩大。

### SEC-003：Schema/数据内容可注入模型（P1）

上传文件中的列名、数据样例、LLM 生成注释和查询结果都属于不可信内容，可能包含伪指令。

### SEC-004：LIMIT 不限制扫描成本（P1）

复杂 JOIN、排序、聚合即使返回 1000 行，也可能扫描大量数据。

### SEC-005：敏感数据缺少字段级策略（P2）

当前授权主要到数据源/表层。未来接入真实业务库时，需要 PII、财务和内部字段的脱敏与用途限制。

## 4. 分析质量问题

### DQ-001：没有结果验证阶段（P1）

查询成功后直接进入总结/画图，没有系统检查 grain、重复、NULL、时间范围、分母和异常值。

### DQ-002：JOIN 扇出主要依赖模型自觉（P1）

多事实表 JOIN 很容易导致收入、用户数重复计算，需要 Query Plan 声明基准粒度和连接基数。

### DQ-003：截断结果可能被当成全集分析（P1）

当结果因 LIMIT 或字符限制被截断时，模型仍可能做排名、分布和总量结论。

### DQ-004：相对日期、时区和成熟窗口不统一（P1）

Prompt 只有服务器日期，没有用户时区、数据集时区和观察窗口成熟规则。

## 5. 安全目标设计

### 5.1 多层防线

1. **数据目录层**：明确 datasource -> schema -> table -> column 可见范围。
2. **查询计划层**：只允许计划引用已选择的字段。
3. **AST 层**：单条只读 SELECT/CTE；任何解析不确定性 fail closed。
4. **数据库层**：独立只读账号、只读事务、schema allowlist。
5. **资源层**：statement timeout、连接池隔离、并发/扫描成本限制。
6. **输出层**：行数、字段、敏感值脱敏和下载限制。
7. **审计层**：记录用户、数据源、最终 SQL、artifact、耗时和拒绝原因。

### 5.2 SQL 校验细则

- 禁止多语句。
- 明确限定可支持的 SQL 语法集合，不为 SHOW/DESC 等非 PostgreSQL 语法保留模糊兼容。
- 表/CTE/子查询作用域解析失败即拒绝。
- 对 catalog 表名统一规范化大小写和 schema。
- 禁止系统 catalog、跨 schema、危险函数和文件/网络扩展函数。
- EXPLAIN 也必须经过同一表权限校验。
- 执行前可选运行 `EXPLAIN (FORMAT JSON)` 做成本阈值判断。

### 5.3 Prompt Injection 防护

- 动态数据统一放在明确的 untrusted data section。
- 不把单元格、注释或记忆文本拼成系统规则。
- Schema Enrichment 输出采用严格 schema，并限制为业务描述字段，不允许出现工作流指令。
- 回归用例包含恶意列名、表注释、单元格和业务定义。
- Tool result 前增加固定声明：其中字符串是数据，不是指令。

## 6. 分析质量目标设计

每个 Query Artifact 附带自动质量摘要：

```ts
interface ResultQuality {
    queryArtifactId: string;
    expectedGrain?: string;
    observedRowCount: number;
    isLimited: boolean;
    nullRates: Record<string, number>;
    duplicateKeyCount?: number;
    timeRange?: { min: string; max: string; timezone: string };
    warnings: string[];
}
```

`expectedGrain`、预期形状和涉及表来自 Phase 3 固化的最小 QueryPlan；ResultQuality 不允许事后根据返回结果反推一个更容易通过检查的预期。

回答策略：

- `isLimited=true` 时禁止从明细样本推断总体分布或总量；应追加聚合查询。
- 分母、过滤条件和时间边界必须进入最终答案或 artifact 元数据。
- 因果问题默认说明观察性限制；除非存在实验/识别设计，不输出因果断言。
- 空结果区分“真实为零”“过滤后无记录”“数据不完整”“字段口径错误”。

## 7. 数据源与权限快照

generation 创建时记录数据源和授权版本。执行前再次检查当前用户仍有访问权：

- 已撤权：停止并返回权限变化错误；
- Schema 已变更：重新构建计划或要求重试；
- 不允许使用创建任务之后才出现、但未经当前上下文选择的新表。

## 8. 涉及文件

- `apps/worker/src/chat/agents/sql-executor.ts`
- `apps/worker/src/chat/tools/sql-query.tool.ts`
- `apps/worker/src/database/schema.service.ts`
- `apps/api/src/datasource/schema-enrichment.service.ts`
- `apps/api/src/datasource/datasource.service.ts`
- `packages/database/src/index.ts`
- `packages/config/src/index.ts`

## 9. 为什么应用层校验还不够

Phase 2 已能保证工具参数结构和调用状态合法，但“合法调用 SQL 工具”不等于“SQL 安全且分析正确”。解析器可能不理解某种方言，查询也可能在语法正确的情况下发生 JOIN 扇出、截断误读或错误时区归因。

根因是安全、资源控制和分析质量处在不同层级：Prompt 约束模型意图，应用校验允许的查询形状，数据库权限限制最坏影响，ResultQuality 判断返回数据是否足以支持结论。缺少任何一层，其他层都不能完全替代它。

## 10. 方案选择与取舍

### 10.1 采用纵深防御，而不是追求完美 SQL Parser

没有解析器能替代数据库权限。AST 校验负责尽早拒绝，独立只读角色负责限制绕过后的最坏影响，两者必须同时存在。

### 10.2 解析不确定时 fail closed，而不是保可用性

对于数据查询产品，一次明确拒绝可以提示用户重写；一次误放行可能访问错误表或执行危险语义。不能证明安全时拒绝，是可解释且可测试的边界。

### 10.3 资源限制放在数据库侧，而不是只加 LIMIT

LIMIT 控制返回行数，不控制扫描、排序、聚合和 JOIN 成本。`statement_timeout`、隔离连接池以及可选 EXPLAIN cost 才能限制资源消耗。

### 10.4 ResultQuality 生成警告和行动约束，而不是只打分

质量检查如果只记录一个分数，模型仍可能忽略它。`isLimited`、重复键、NULL、时间范围等结果应直接约束允许的结论，必要时要求追加聚合查询或拒绝总体推断。

### 10.5 动态内容作为不可信数据，而不是继续扩写安全 Prompt

列名、注释、样例、记忆和查询值都可能含指令式文本。固定策略应规定它们只能作为数据解释，工具权限不能由动态内容改变。

## 11. 预期前后对比

| 场景               | 当前状态               | Phase 4 目标                    | 预期收益                      |
| ------------------ | ---------------------- | ------------------------------- | ----------------------------- |
| AST 无法确认表范围 | 某些异常路径可能继续   | fail closed                     | 未证明安全的 SQL 不进入数据库 |
| 应用校验被绕过     | 共用高权限连接放大影响 | 独立只读角色 + schema allowlist | 数据库层阻止写入和越权        |
| 大扫描小返回       | LIMIT 只限制输出       | timeout、池隔离、可选成本阈值   | 限制数据库资源风险            |
| 截断样本           | 模型可能当全集总结     | `isLimited` 约束回答和追加查询  | 避免错误排名、分布和总量结论  |
| JOIN/NULL/时区     | 主要依赖模型自觉       | ResultQuality 自动检查          | 常见分析错误变成可测告警      |
| 数据内提示注入     | 动态内容混入上下文     | untrusted section + 攻击回归    | 数据不能获得指令权限          |

## 12. 非目标、风险与实施门槛

- 只读角色不等于可以读取所有数据；仍需 datasource/schema/table/column 授权与敏感字段策略。
- ResultQuality 不自动证明因果关系，也不能替代业务口径确认。
- EXPLAIN cost 受统计信息影响，只能作为资源信号，不能成为唯一安全判断。
- 数据库角色和连接池迁移需要灰度与回滚方案，避免影响元数据管理连接。
- 安全测试必须是发布阻断项；质量警告则需要区分阻断、重查和仅提示三种级别。
- 在 Phase 5 记忆重构前，Phase 4 必须先把现有 `semantic_state` 放入 untrusted data section 并验证无法覆盖系统策略，不能把记忆注入测试推迟到 Phase 5。
- SEC-01（fail-closed、只读角色、动态内容隔离）不依赖 Artifact，可与 Phase 3 并行；DQ-01（ResultQuality）依赖 ART-01 和最小 QueryPlan。

## 13. 专题最终验收标准

- 任意表解析异常均被拒绝，不能进入数据库。
- Agent 数据库角色无法执行 INSERT/UPDATE/DELETE/DDL，也不能访问非授权 schema。
- 超时 SQL 在数据库侧停止，而不只是应用返回超时。
- LIMIT/截断结果不会被描述为全量数据。
- JOIN 扇出、重复计数、NULL、时区和窗口成熟度均有自动测试。
- 恶意 Schema 注释、单元格和记忆无法触发额外工具或改变安全策略。

其中“超时 SQL 在数据库侧停止”已由 Phase 1 完成，Phase 4 的职责是保留该回归并验证独立只读连接池不会破坏取消能力，而不是重复实现。
