# Phase 4 决策与实施记录：安全与分析质量

> 阶段状态：已完成
>
> 完成日期：2026-09-18

## 1. 阶段结论

Phase 4 将数据查询从“应用层尽量检查”升级为纵深防御。Agent 查询有独立连接池和数据库角色；SQL 解析、表、schema、危险函数和字段范围无法证明安全时直接拒绝；查询结果生成结构化 ResultQuality，并把截断、重复粒度、JOIN、NULL、空结果和时区风险变成模型必须遵守的行动约束。

## 2. 输入、输出与不变量

- 输入仍为 Phase 3 的 QueryPlan 与 SQL，不引入不兼容工具参数。
- 只允许单条 PostgreSQL SELECT；不再接受 SHOW、DESC、EXPLAIN 或多语句。
- catalog 是表权限事实源；字段策略支持 allow、mask、deny。
- 生产环境必须配置 `AGENT_DB_USER`、`AGENT_DB_PASSWORD`，否则数据库配置 fail closed。
- Query Artifact 增加可选 `result_quality`，旧 Artifact 与 Phase 3 回滚路径仍可读取。
- blocking 质量警告禁止基于样本输出全集、分布、排名或总量结论。

## 3. 实现

- `DatabaseClient` 将应用读写池与 Agent 查询池分离，查询池继续使用只读事务、数据库 statement timeout 和后端取消。
- `init-db` 创建/收敛 NOSUPERUSER、NOCREATEDB、NOCREATEROLE、默认只读的登录角色，只向 catalog 中开放的业务表授予 SELECT；上传新表时同步授权。
- SQL 校验拒绝多语句、非 SELECT、非 public schema、未授权表、危险函数、受限字段和受限字段场景下的 `SELECT *`；解析异常不再交给执行层碰运气。
- `datasource_column_policy` 保存字段分类与 allow/mask/deny 策略；deny 字段不进入 Schema，mask 字段输出 redact、last4 或 hash。
- `ResultQualityV1` 记录行数、LIMIT/工具截断、NULL 率、可识别粒度的重复数、时间范围与 UTC 假设、结构化警告及行动要求。
- Schema、semantic_state 和工具数据都进入明确的 untrusted data 边界，不能覆盖系统规则。

## 4. 迁移、兼容与回滚

- 迁移以 `ADD COLUMN IF NOT EXISTS` 和 `CREATE TABLE IF NOT EXISTS` 幂等执行。
- `result_quality` 为可选字段；没有质量摘要的旧记录保持兼容。
- 非生产环境未配置 Agent 凭据时暂时复用主账号，便于本地升级；生产环境不允许该回退。
- 回滚可切回旧应用版本；新增 JSONB 字段和策略表保留，不做破坏性删除。

## 5. 自动化验证

| 命令 | 覆盖 | 结果 |
| --- | --- | --- |
| `pnpm test:phase4` | SQL fail-closed、CTE、危险函数、字段 deny/mask、注入边界、质量警告、生产配置 | PASS |
| `pnpm test:phase4` 数据库部分 | 迁移幂等、独立临时只读角色、授权表 SELECT、写入拒绝、未授权表拒绝、statement timeout | PASS |
| `pnpm test:phase3` | Artifact、上下文、迁移兼容 | PASS |

数据库集成测试只创建唯一命名的临时角色和表，并在 `finally` 中撤权和删除。浏览器交互验收不属于本阶段自动化范围，未运行。

## 6. 未解决问题

- 字段策略已有执行基础，但批量管理 UI、组织级策略继承和审计报表留给后续产品化。
- ResultQuality 是确定性风险检查，不证明业务定义或因果关系正确。
- 百表规模的 Schema 召回、EXPLAIN 成本阈值调优、生产 dashboard 和真实 Agent 评分属于 Phase 6。
- 长期记忆的来源、版本、冲突和撤销语义由 Phase 5 承接。
