# 分析状态与草稿提交机制

用途：帮助开发者理解 `analysis_state` 与 `analysis_state_draft` 为什么存在、分别保存什么、如何随 Generation 变化，以及它们与消息、Turn、Memory、Artifact 的边界。本文描述当前实现，不把历史上无法证明的设计动机当作事实。

相关入口：[ADR-002](../decisions/002-analysis-draft-commit.md)、[Generation 生命周期](generation-lifecycle.md)、[上下文与状态](context-and-state.md)、[数据库模型](../design/data-model.md)。

## 1. 先建立一个直观模型

用户连续追问时，系统不能只依赖聊天文字猜测“那”“继续”“换成渠道维度”指什么。它还维护一份结构化的分析上下文，例如：

```json
{
  "question": "按渠道分析 10 月销售额",
  "datasourceId": 12,
  "timeRange": {
    "start": "2026-10-01T00:00:00+08:00",
    "endExclusive": "2026-11-01T00:00:00+08:00",
    "timezone": "Asia/Shanghai"
  },
  "filters": [{ "field": "orders.is_test", "operator": "eq", "value": false }],
  "grain": "每行一个渠道",
  "freshness": "reuse_allowed"
}
```

这份结构化上下文就是 `AnalysisState`。它不是回答正文，不是模型的隐藏思考，也不证明 SQL 或结论一定正确。它只声明当前分析任务采用的范围、条件、口径版本、假设和未决问题。

数据库中存在它的两个阶段：

| 名称 | 表 | 准确含义 |
| --- | --- | --- |
| 已提交分析状态 | `analysis_state` | 最近一次成功终结的 Generation 留给后续追问继承的状态 |
| 本轮分析草稿 | `analysis_state_draft` | 当前 Generation 正在修改、尚未获准成为后续基础的状态 |

代码和文档有时把前者称为“正式状态”。这里的“正式”仅表示 **committed（已提交）**，不表示经过人工审核或业务上绝对正确。可以把两者理解为：

```text
analysis_state       = 会话当前已提交的书签
analysis_state_draft = 本轮运行中的候选新书签
```

## 2. 为什么需要草稿

一次回答可能经历多次模型调用和工具调用：继承上轮状态、补齐时间范围、增加筛选、查询 SQL、读取证据、生成图表，最后才输出答案。期间任何一步都可能报错、超时或被取消。

例如，已提交状态是“分析 10 月销售额，排除测试订单”，用户接着要求“按渠道拆分，并排除内部渠道”。本轮运行先把新条件写入状态，随后 SQL 失败：

```text
已提交状态：10 月销售额 + 排除测试订单
       ↓ 复制
本轮草稿：  10 月销售额 + 按渠道 + 排除测试订单 + 排除内部渠道
       ↓
SQL 失败
```

如果运行过程中直接覆盖 `analysis_state`，下一轮会继承一组没有成功结果支撑的新条件。草稿将运行中的可变状态隔离出来：

- Generation 成功终结：草稿与完成状态在同一事务中提交，成为新的 `analysis_state`。
- Generation 失败或取消：草稿不提升，下一轮仍从上一次已提交状态开始。

草稿使用数据库而不只放在 Worker 内存中，还有三个现实作用：

1. 一轮内的多次工具调用可以读取和乐观更新同一版本化状态。
2. checkpoint、错误诊断和运行记录不依赖某个 Worker 进程的临时内存。
3. 不需要在模型和工具运行的整个耗时期间持有一个长数据库事务。

## 3. 它解决什么，不解决什么

`AnalysisState` 解决的是“后续分析应该继承哪些结构化条件”，不是所有上下文和数据的总和。

| 对象 | 保存什么 | 能否替代分析状态 |
| --- | --- | --- |
| 聊天消息 / Turn | 用户原话、最终回答和展示块 | 不能；自然语言历史用于理解指代，但不是结构化条件 |
| `analysis_state` | 当前任务、源、口径引用、时间、筛选、粒度、假设、未决问题 | 本文讨论的已提交上下文 |
| `analysis_state_draft` | 某个 Generation 的工作状态、Memory 快照和上下文报告 | 只能在该轮运行中使用，成功后才可提升 |
| Datasource Memory | 经确认的长期业务口径和知识 | 不能；生命周期独立，草稿只引用其精确版本 |
| Query / Chart Artifact | 查询证据、结果数据和展示定义 | 不能；状态描述条件，Artifact 才是执行证据 |
| assistant/tool 协议 | 本轮模型实际发起的调用和工具反馈 | 不能；它是本轮执行上下文，不是跨轮状态 |

尤其要注意：`filters`、`timeRange` 和 `grain` 写进状态，并不自动证明生成的 SQL 落实了它们。证据适用性和实际执行 SQL 仍需单独检查。

## 4. 数据库表设计

Schema 的源码定义在 [`packages/database/src/analysis-state-schema.ts`](../../packages/database/src/analysis-state-schema.ts)。以下 DDL 省略格式差异，但保留当前约束：

```sql
CREATE TABLE analysis_state (
  conversation_id UUID PRIMARY KEY REFERENCES conversation(id) ON DELETE CASCADE,
  revision        INTEGER NOT NULL CHECK (revision > 0),
  state           JSONB NOT NULL CHECK (jsonb_typeof(state) = 'object'),
  generation_id   UUID NOT NULL REFERENCES generation(id),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE analysis_state_draft (
  generation_id   UUID PRIMARY KEY REFERENCES generation(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
  base_revision   INTEGER NOT NULL CHECK (base_revision >= 0),
  revision        INTEGER NOT NULL CHECK (revision > base_revision),
  state           JSONB NOT NULL CHECK (jsonb_typeof(state) = 'object'),
  memories        JSONB NOT NULL,
  context_reports JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### 4.1 `analysis_state`

每个会话最多一行，因为 `conversation_id` 是主键。

| 字段 | 作用 |
| --- | --- |
| `conversation_id` | 状态归属；同时保证一个会话只有一个当前已提交状态 |
| `revision` | 当前已提交版本；值可能跨过多个数字，因为草稿每次更新也递增 revision |
| `state` | 完整 `AnalysisState` JSON |
| `generation_id` | 最后一次成功提交该状态的 Generation |
| `updated_at` | 最近提升时间 |

系统不为每次正式状态建立独立历史表；旧值被后续成功 Generation 覆盖。相关运行和证据仍分别保存在 Generation、Turn、消息和 Artifact 表中。

### 4.2 `analysis_state_draft`

每个 Generation 最多一行，因为 `generation_id` 是主键。失败或已提升的草稿当前不会立即删除，它仍可用于诊断；删除 Generation 时会级联删除。

| 字段 | 作用 |
| --- | --- |
| `generation_id` | 草稿所属运行，也是草稿唯一键 |
| `conversation_id` | 用于读取和锁定对应会话 |
| `base_revision` | `begin` 时看到的已提交版本；没有已提交行时为 `0` |
| `revision` | 草稿当前版本；创建和每次成功修改都会递增 |
| `state` | 本轮可变的 `AnalysisState` JSON |
| `memories` | 本轮开始时读取的 active Memory 全量版本快照，不含候选 |
| `context_reports` | 每次模型请求的上下文预算和选择报告，主要用于诊断裁剪 |
| `updated_at` | 草稿最近更新时间 |

`base_revision` 与 `revision` 不可混用：

```text
base_revision：本轮是从哪个已提交版本出发的
revision：      本轮草稿已经修改到哪个版本
```

假设已提交状态为 revision 5：

```text
begin                 base_revision=5, draft.revision=6
第一次状态 patch       base_revision=5, draft.revision=7
保存最终业务 outcome   base_revision=5, draft.revision=8
promote               analysis_state.revision=8
```

因此正式 revision 不保证每轮只增加 1。

## 5. `AnalysisState` 保存哪些字段

类型定义在 [`packages/contracts/src/analysis.ts`](../../packages/contracts/src/analysis.ts)。

| 字段 | 语义 |
| --- | --- |
| `taskId` | 会话内分析任务标识；同一任务可跨多个 Generation，`start_new_task` 会重建 |
| `conversationId` | 所属会话 |
| `datasourceId` | 当前分析数据源；换源时不会沿用旧状态 |
| `revision` | JSON 内状态版本，与草稿或正式行的 revision 同步 |
| `question` | 当前工作问题；`begin` 不会自动用新消息覆盖，需模型显式 patch |
| `status` | `active` 或 `complete / partial / awaiting_clarification / unable_to_complete` |
| `memoryRefs` | 本轮采用的正式 Memory 精确 `{id, version}` 引用 |
| `temporaryNotes` | 当前任务的临时约定，绑定来源消息，不写入长期 Memory |
| `timeRange` / `comparisonRange` | 带时区、左闭右开的分析区间和对比区间 |
| `filters` | 经授权 Schema 校验字段名的显式筛选条件 |
| `grain` | 期望分析粒度的文本声明 |
| `freshness` | 允许复用历史证据，或要求当前 Generation 重新查询 |
| `hypotheses` | 假设、判断状态及其证据引用 |
| `openQuestions` | 尚待确认的问题 |

## 6. 一轮 Generation 的完整代码路径

### 6.1 创建 Generation：同一会话串行

[`apps/api/src/chat/generation.service.ts`](../../apps/api/src/chat/generation.service.ts) 的 `createTurn`：

1. 获取用户级 advisory transaction lock。
2. 获取会话级 advisory transaction lock。
3. 检查 Idempotency-Key。
4. `FOR UPDATE` 锁定并验证会话。
5. 如果同会话已有 `pending / starting / running / cancel_requested` Generation，返回 `CONVERSATION_GENERATION_ACTIVE`。
6. 创建请求消息、响应消息、Generation、Turn 和 enqueue Outbox。

数据库在 [`packages/database/src/schema.ts`](../../packages/database/src/schema.ts) 还有最终约束：

```sql
CREATE UNIQUE INDEX uk_generation_conversation_active
ON generation(conversation_id)
WHERE status IN ('pending', 'starting', 'running', 'cancel_requested');
```

所以当前正常产品路径中，同一个会话不会同时执行两个活动 Generation。用户可以在不同会话并行运行任务，但它们不会共享同一行 `analysis_state`。

### 6.2 `begin`：从已提交状态创建本轮草稿

[`AnalysisStateRepository.begin`](../../apps/worker/src/analysis/analysis-state.repository.ts) 在独立短事务中执行：

1. 锁定 Generation，并校验当前 Worker 仍持有 `writer_token`，状态仍为 `starting/running`。
2. 如果该 Generation 已有草稿，直接返回，避免重复初始化。
3. 读取会话的 `analysis_state`。
4. 同数据源时深拷贝已有状态；换源或没有状态时创建新的 `AnalysisState`。
5. 设置 `revision = base_revision + 1`、`status = active`。
6. 根据本轮固定 Memory 快照移除失效的精确版本引用，并清理依赖它们的假设。
7. 插入 `analysis_state_draft`。

注意：新用户消息保存在 Generation snapshot 和模型 user 消息中；`begin` 不会直接覆盖继承状态的 `state.question`。模型必须通过 `update_analysis_state` 明确确认或修改本轮问题。

### 6.3 `update_analysis_state`：乐观更新草稿

工具定义位于 [`apps/worker/src/analysis/analysis-tools.ts`](../../apps/worker/src/analysis/analysis-tools.ts)。模型在查询、回读证据或绘图前，必须独立调用该工具确认本轮条件。

`patchAnalysisState` 负责校验字段、Memory 版本、时间范围和证据引用，并产生 `revision + 1` 的新状态。随后 [`AnalysisStateRepository.save`](../../apps/worker/src/analysis/analysis-state.repository.ts) 使用条件更新：

```sql
UPDATE analysis_state_draft
SET revision = ?, state = ?, updated_at = NOW()
WHERE generation_id = ? AND revision = ?;
```

最后一个条件是本轮内部的乐观锁。如果调用方持有旧 revision，更新行数不是 1，代码抛出“分析草稿版本冲突”。成功后才替换 Worker 内存中的 `session.state`。

### 6.4 Runtime 收尾：把业务 outcome 写回草稿

[`AnalysisRuntimeAdapter.run`](../../apps/worker/src/analysis/analysis-runtime-adapter.ts) 获得 Agent outcome 后，再把：

- `revision` 加 1；
- `status` 更新为 `complete / partial / awaiting_clarification / unable_to_complete`；
- 必要时用 `missingItems` 更新 `openQuestions`。

然后仍通过 `states.save` 写入草稿。这里的业务状态不等于 Generation 执行终态。例如 `partial` 和 `awaiting_clarification` 仍可能对应一个正常 `completed` Generation。

### 6.5 `finalize`：与 Generation 完成原子提交

[`GenerationService.finalize`](../../apps/worker/src/chat/generation.service.ts) 开启最终事务。只有目标执行状态是 `completed` 时，才调用 [`promoteAnalysisDraft`](../../packages/database/src/analysis-state-schema.ts)：

```text
最终事务
├── generation → completed，并清除 writer_token
├── 锁定 analysis_state_draft
├── 锁定 conversation
├── 校验 current analysis_state.revision == draft.base_revision
├── upsert draft.state → analysis_state
├── 保存 message.content / blocks / llm_messages
├── conversation_turn → completed，保存 final_answer
├── generation_attempt → completed
└── 写 done 事件及 Outbox
```

上述任一步失败，整个事务回滚，不能出现“Generation 已 completed，但新分析状态没有提交”的持久化结果。

如果草稿不存在，抛出 `ANALYSIS_DRAFT_MISSING`；如果基础版本不一致，抛出 `ANALYSIS_STATE_CONFLICT`。执行壳会把这类完成失败转成 failed，而不会发布一个状态不一致的成功结果。

## 7. 两种 revision 检查分别防什么

系统有两个层次的版本检查：

| 检查 | 比较内容 | 防止的问题 |
| --- | --- | --- |
| 草稿保存检查 | `draft.revision == expectedRevision` | 同一 Generation 内用旧状态覆盖较新的草稿 |
| 草稿提升检查 | `committed.revision == draft.base_revision` | 从旧基础产生的草稿覆盖新的已提交状态 |

第二种常被描述为“跨轮并发控制”，但需要准确理解当前实现：

- 正常用户路径已经强制同会话单活动 Generation，所以不会日常出现两个同会话回答竞争提交。
- `base_revision` 仍是数据库层的防御性不变量，可防止绕过 API 的写入、未来放宽串行限制、维护脚本或异常路径把旧草稿覆盖到新状态。
- 会话行锁还覆盖“当前不存在 `analysis_state` 行”的首次提交场景；仅锁状态行无法锁住一条不存在的记录。

因此，草稿机制的首要理由是失败/取消隔离；版本冲突检查是额外的一致性防线，不应被文档描述成当前产品的常规交互。

## 8. 不同终态下哪些内容生效

| 情况 | Generation / Turn | 草稿是否提升 | 下一轮继承 |
| --- | --- | --- | --- |
| 正常 complete | `completed` | 是 | 新状态，业务 status=`complete` |
| partial | `completed` | 是 | 部分结果及其未决问题 |
| awaiting clarification | `completed` | 是 | 已确认条件和待澄清项 |
| unable to complete | `completed` | 是 | 已形成的状态和不能完成原因相关上下文 |
| LLM、工具或外围执行异常 | `failed` | 否 | 上一次已提交状态 |
| 用户取消 | `cancelled` | 否 | 上一次已提交状态 |
| 草稿缺失或提升冲突 | 最终转 `failed` | 否 | 上一次已提交状态 |

“是否提升”的判断依据是 Generation 执行终态 `completed`，不是 `AnalysisState.status === complete`。

## 9. 为什么不采用更简单的方案

### 9.1 运行时直接更新 `analysis_state`

实现简单，但失败、取消或中途错误会污染下一轮继承状态。若要回滚，还必须可靠保存并恢复旧状态，并处理恢复本身失败的问题。

### 9.2 只在 Worker 内存保存，最后一次性落库

无法提供持久化的中间版本和上下文报告；进程退出后也缺少诊断材料。多次工具调用仍需自行维护一致性。

### 9.3 从开始到结束保持一个数据库事务

模型与外部工具可能运行很久。长事务会长期占用连接和锁、阻碍清理并增加故障影响，不适合包住整轮 Agent 执行。

### 9.4 完成后从聊天正文重新推导状态

正文是面向用户的非结构化输出，可能省略筛选、时区、口径精确版本或未决假设。重新解析既不确定，也无法稳定实施版本检查。

## 10. 修改代码时应维持的不变量

涉及分析状态时，至少检查以下约束：

1. 只有仍持有 writer ownership 的活动 Generation 可以创建或修改草稿。
2. 草稿所有修改必须校验旧 revision，成功后才更新内存 session。
3. `AnalysisState.revision`、草稿行 `revision` 和最终正式行 `revision` 保持一致。
4. 只有 Generation `completed` 才提升草稿。
5. 提升必须与 Generation、消息、Turn、attempt 和 done Outbox 的完成写入处于同一事务。
6. 提升前必须校验 `base_revision`，并正确序列化首次提交时的无行场景。
7. failed / cancelled 的草稿不得成为下一轮 `begin` 的基础。
8. 不要把 Memory 候选或 Memory 工具回执中的 `draft` 与 `analysis_state_draft` 混为一谈。
9. 不要把状态条件当作 SQL 已正确执行的证明；Evidence/Artifact 校验仍需保留。
10. 如果调整同会话活动 Generation 限制，必须重新评估跨轮并发、parent 选择、Turn 顺序和草稿提升策略。

## 11. 排障顺序

当出现“页面似乎回答完成，但下一轮没有继承条件”时，按下面顺序排查：

1. 查 `generation.status` 和 `conversation_turn.status`，确认是否真正 `completed`。
2. 查该 Generation 的 `analysis_state_draft` 是否存在，`state` 是否包含预期 patch。
3. 比较 `analysis_state_draft.base_revision` 与提交前的 `analysis_state.revision`。
4. 查 `analysis_state.generation_id` 是否指向该 Generation，以及 revision/state 是否已提升。
5. 查 finalize 错误是否为 `ANALYSIS_DRAFT_MISSING` 或 `ANALYSIS_STATE_CONFLICT`。
6. 如果正式状态已提升但行为仍不符合预期，再检查新一轮是否换了数据源、Memory 精确版本是否失效，以及模型是否显式更新了 `state.question`。
7. 最后检查 Query Artifact 的条件签名和实际 `executed_sql`；不能根据页面已有文字或图表推断状态与证据都已正式提交。

## 12. 一句话总结

`analysis_state` 是后续追问可继承的“最近已提交分析上下文”；`analysis_state_draft` 是当前 Generation 的持久工作区。系统允许它在运行中多次修改，但只在 Generation 成功完成时，才与消息、Turn 和完成事件一起原子提升。
