# 业务定义与会话分析状态

> 归属、独立模块、轻量结构化、显式更新为已确认决策；下列字段、接口和事务方式为实施约定。

## 1. 三类对象必须分开

| 对象 | 生命周期 | 权威内容 |
| --- | --- | --- |
| BusinessDefinition | 数据源级，跨会话 | 用户确认的业务语义 |
| AnalysisState | 一个会话的当前任务 | 本次问题、条件、引用和待验证解释 |
| Query/Chart Artifact | 一次真实执行的记录 | SQL、结果、质量信息、图表来源 |

查询结果和模型推断不进入长期业务定义；历史自然语言结论不是数据事实来源。首期只支持一个数据源内分析，不实现跨源 JOIN 或跨源知识继承。

## 2. 独立业务定义模块

建议位置：`apps/api/src/business-definition/`；前端新增独立 `/business-definitions` 页面（带数据源选择器），类型放共享 contracts。可以从现有数据源页面增加跳转入口，但不得替换 `DataSourceView` 或改变上传、表管理等职责。

Worker 经共享 repository/领域接口读定义，不经自己的 HTTP 回调 API，不直接调用旧 MemoryService。数据库仍用现有基础设施。

### 2.1 数据模型

`business_definition` 保存 ID、datasourceId、当前 revision、active/deleted 状态与审计时间。`business_definition_revision` 保存每次确认后的不可变内容；历史引用使用 `(id, version)`。

| 字段 | 规则 |
| --- | --- |
| id / datasourceId / version | 服务端赋值；每次确认修改 version + 1 |
| type | metric / term / relationship |
| name / description | 必填，用户可读业务含义；不允许空白 |
| aliases | 可选，辅助发现，不作为跨定义自动合并依据 |
| metric | 指标可含 numerator、denominator、entityGrain、timeWindow、timezone、unit、conditions；自然语言结构化字段，不执行表达式 |
| relationship | 关系类型填写左右表字段、预期基数及解释；是确认的业务说明，不能授权额外表 |
| relatedFields | 可选表字段引用，保存时校验当前数据源；失效后标为需要检查 |
| source | manual 或 conversation；createdBy、confirmedBy、sourceMessageId（对话来源必填）由服务端校验 |
| createdAt / updatedAt | 服务端时间 |

term 不要求填分子分母；metric 不是比率时 denominator 可空。必需语义随指标而定，不能靠“表单非空”宣称口径完整。Agent 遇到缺失且影响结论的条件仍需澄清。

同数据源 active 定义的规范化名称唯一，重复创建返回冲突；同义词碰撞不自动选一个。字段变化导致相关定义失效时不能静默生成新解释，应提示用户修订。

### 2.2 候选与确认

`business_definition_candidate` 单独保存待确认内容、来源 message/generation、目标 definitionId 与 expectedVersion（修改候选）、pending/accepted/rejected 状态。候选不参与已确认知识召回。

1. 用户在管理页直接新增或编辑并保存，即明确确认，写入正式定义版本。
2. 对话中用户明确一个临时口径，可立即写入本轮状态，来源指向该用户消息；不等于同意永久保存。
3. Agent 可提出保存候选，展示完整字段及“仅本次使用 / 保存到业务定义 / 放弃”选择。
4. 只有经过认证的用户确认操作才能把候选转为正式版本。首期使用确认卡片/按钮；不让模型根据含糊的“可以”自行长期写入。
5. 候选确认与正式版本写入同一事务，重复确认幂等；旧版本修改冲突返回 409，刷新后再确认，禁止最后写入者覆盖。

首期不做多级审批、自动置信度阈值或候选自动合并。Agent 没有确认/删除正式定义的工具。候选在 generation 内先暂存，成功 finalize 后才展示为可确认；取消或失败任务的候选不自动进入待办。

### 2.3 HTTP 契约

路径为本项目拟新增接口，不是外部 YApi 契约。统一 JSON 请求/响应；所有 ID 均先授权，身份来自登录态。

| 方法与路径 | 参数位置 | 行为 |
| --- | --- | --- |
| GET `/business-definitions` | query: datasourceId 必填；type、q、cursor、limit 可选 | 当前有效定义分页，返回 items/nextCursor |
| GET `/business-definitions/:id` | path: id；query: version 可选 | 当前或指定历史版本，删除状态也明确返回 |
| POST `/business-definitions` | body: datasourceId、type、name、description 及可选类型字段 | 用户直接创建已确认定义，返回完整记录 |
| PATCH `/business-definitions/:id` | path: id；body: expectedVersion、允许内容字段 | 乐观锁修改，返回新版本 |
| DELETE `/business-definitions/:id` | path: id；query: expectedVersion | 逻辑删除并递增版本，立即退出新召回；成功 204 |
| GET `/business-definition-candidates` | query: datasourceId，conversationId 可选 | 本用户可处理的待确认候选 |
| POST `/business-definition-candidates/:id/confirm` | path: id；body: expectedVersion（候选版本） | 事务确认；修改候选还校验其目标定义版本 |
| POST `/business-definition-candidates/:id/reject` | path: id；body: expectedVersion | 拒绝候选，不修改已确认定义 |

创建/更新只接收对应类型白名单字段，不接受 userId、confirmedBy、权限字段。分页 limit 默认 20、最大 100；空白内容 400，无认证 401，无资源访问权统一 404，版本/名称冲突 409。读定义要求数据源读权限，写定义和确认要求数据源管理权限；首期若现有权限没有细分，仅所有者可写，不另建角色系统。

### 2.4 修改、删除和历史

每 generation 开始读取当前定义版本快照；同一 generation 不混用新旧版本。外部修改对下一次分析生效，并检测会话状态中的旧版本。用户本轮明确要求使用历史口径时，作为显式历史对比记录，而非默默沿用旧默认。

删除意味着从当前知识中移除；历史答案可保留当时定义快照并标注已删除。不是承诺彻底清除所有历史痕迹。数据源删除或授权撤销后，历史快照不能绕过权限继续对外可见。

## 3. 会话分析状态

```ts
type AnalysisState = {
  taskId: string;                    // 服务端生成；会话中仅一个当前任务
  conversationId: string;
  datasourceId: number;
  revision: number;
  question: string;
  status: 'active' | 'awaiting_clarification' | 'answered' | 'partial';
  definitionRefs: { id: string; version: number }[];
  temporaryDefinitions: { name: string; description: string; sourceMessageId: string }[];
  timeRange: { start: string; endExclusive: string; timezone: string } | null;
  comparisonRange: { start: string; endExclusive: string; timezone: string } | null;
  filters: { field: string; operator: string; value: unknown }[];
  hypotheses: { id: string; statement: string; status: 'open' | 'supported' | 'refuted' | 'unresolved'; evidenceIds: string[] }[];
  openQuestions: string[];
};
```

筛选用有限类型与 operator 白名单，不执行任意表达式；字段必须属于已获授权 Schema。未解决值用 null/openQuestions，不能编造默认。时间规范采用半开区间，时区明确；SaaS 基准使用固定数据锚点，不自动用系统当天代替测试锚点。

单独由系统记录状态 revision 对应的已执行 Artifact、实际 SQL、失败尝试和预算；这些事实不由 patch 写入。hypothesis 的 supported 是模型判断，必须有证据引用，但不能被 UI 表示成程序已证明。

## 4. 更新协议与一致性

`update_analysis_state` 接收 expectedRevision、白名单 patch 和短变更说明，不接受任意 JSON Patch 路径。原子校验并保存后返回 authoritative state/revision；模型收到成功前，不按假定新条件查数。

- 业务引用、筛选、临时口径和证据引用逐项授权与校验。
- 服务端决定 datasourceId、taskId、revision、来源用户身份；不能由模型任意更改。
- 当前用户明确约定优先于旧默认；但系统只能验证来源消息存在，语义是否真实对应仍需要案例检验。
- 同轮工具以当前 revision 执行，Artifact 固定记录对应状态快照。提交答案前保证引用与最终状态一致；显式跨条件比较必须列出两组条件。
- 状态在 generation 内保存为草稿；外壳成功 finalize 时提升会话状态，失败或取消不污染下一轮。乐观锁仍保留，避免管理操作或异常并发静默覆盖。
- 新任务由状态工具 `start_new_task` 模式发起，清空旧条件与假设；保留旧 Artifact 历史，不维护分支树。是否新任务由当前 Agent 根据用户意图判断，不明确时澄清。
- 更换数据源强制新任务，不能继承旧数据源定义、Schema 或证据。

## 5. 证据失效规则

变更指标定义版本、时间区间、筛选、粒度或数据源，旧 Artifact 标为“需重新判断适用性”，不再默认支持当前结论。数据源/权限不符直接拒绝；其他差异可用于明确标注的历史比较。

只有完整结果包含所需维度、可安全重算且口径匹配时才能复用。首期不建设通用内存计算引擎：需要重新聚合、去重或重算比率时优先查询数据库。纯重画图、核对原结果可直接回读 Artifact。

读取历史 Artifact 不代表数据实时刷新；用户要求最新数据时必须重新查询。没有数据快照版本时显示 queriedAt，不承诺历史查询代表当前数据库。

## 6. 旧记忆的退出

新核心不注册旧 SemanticDistiller，不调用旧 MemoryService 注入，不同时维护旧 MemoryRecord 和业务定义。旧记录不自动全部迁移；仅明确有数据源、用户确认来源、符合新类型的条目可通过显式一次性导入审核进入新定义，其余留在旧数据中，不影响新核心。

退役时移除旧写入口和前端记忆管理入口，替换为独立业务定义入口。移除旧表或历史数据是另一个明确的数据清理任务，本次文档替换和核心开发不授权直接清库。
