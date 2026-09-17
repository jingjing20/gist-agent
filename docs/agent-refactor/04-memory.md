# 04. 记忆系统改造

> 规划状态：对应 Phase 5，尚未实施。当前仍使用 conversation 级 `semantic_state`；本文的 MemoryRecord、patch 协议和管理能力是目标设计。
>
> 排序原因：记忆会把一次理解长期放大，必须等待 Phase 3 的证据引用和 Phase 4 的信任边界稳定后再升级，避免把短期错误结构化并永久保存。

## 1. 目标

建立可追溯、可纠正、可并发更新、可遗忘的记忆系统。记忆只保存未来确实需要复用的信息，不承担查询证据或完整聊天历史的职责。

## 2. 当前实现证据

- conversation 只有一个自由结构的 `semantic_state JSONB`。
- 每轮完成后以 fire-and-forget 方式调用蒸馏器；只在 completed generation 后触发。
- 蒸馏器只读取本轮 user message 和旧 definitions，不读取 assistant 结论或查询结果。
- 模型返回完整 `{ definitions: ... }`，随后整体覆盖 semantic state：`apps/worker/src/chat/agents/semantic-distiller.service.ts`。
- 下一轮把 definitions 直接拼入 System Prompt：`apps/worker/src/chat/prompt-builder.ts`。

## 3. 对当前策略的评价

“只记用户明确给出的业务口径，不自动记模型生成的数据事实”是正确的安全边界，应继续保留。否则一次错误查询可能变成长期记忆并持续污染后续回答。

需要改造的是存储、更新和使用方式，而不是把更多内容无差别记住。

## 4. 问题清单

### MEM-001：并发更新可能丢失（P1）

两个异步蒸馏任务都读取旧状态并整体覆盖，后写入者可能抹掉先写入者的新增定义。

### MEM-002：没有来源和生效范围（P1）

无法回答“这条定义是谁在何时提出的”“只适用于哪个数据源/项目”“是否仍然有效”。

### MEM-003：缺少纠正、撤销和冲突语义（P1）

用户说“以后活跃用户改成近 7 天登录”时，当前实现只能让模型自由改写字典，无法可靠保留新旧关系。

### MEM-004：自由文本被提升到 System Prompt（P0/P1）

恶意或误判内容可能成为持久化 Prompt Injection。

### MEM-005：记忆类型过于单一（P2）

口径、展示偏好、时区、币种和当前任务临时状态具有不同生命周期，不应混在一个 definitions 对象中。

## 5. 记忆分类

| 类型                   | 示例                        | 生命周期          | 是否允许自动写入             |
| ---------------------- | --------------------------- | ----------------- | ---------------------------- |
| `metric_definition`    | 活跃用户 = 当日去重登录用户 | 长期/直到纠正     | 仅用户明确陈述或确认         |
| `dimension_definition` | 华东包括沪苏浙皖            | 长期/直到纠正     | 仅用户明确陈述或确认         |
| `analysis_preference`  | 默认按周展示，优先表格      | 可长期            | 可提议，最好用户确认         |
| `locale_preference`    | Asia/Shanghai、CNY          | 长期              | 用户设置或明确陈述           |
| `task_state`           | 正在分析 8 月留存           | 当前任务          | 系统确定性写入，不进长期记忆 |
| `evidence_reference`   | query artifact ID           | 与会话/保留期一致 | 系统写入，不由模型改写       |

明确禁止自动写入：未经验证的数据事实、因果结论、模型猜测、临时错误信息。

## 6. 推荐数据模型

```ts
interface MemoryRecord {
    id: string;
    userId: number;
    scope: 'user' | 'datasource' | 'conversation';
    scopeId?: string;
    type: MemoryType;
    key: string;
    value: Record<string, unknown>;
    sourceMessageId: string;
    sourceQuote?: string;
    confidence?: number; // 仅用于 proposed 候选，不能替代用户确认
    status: 'proposed' | 'active' | 'superseded' | 'deleted';
    version: number;
    supersedesId?: string;
    confirmedAt?: string;
    createdAt: string;
    updatedAt: string;
    expiresAt?: string;
}
```

`sourceQuote` 只能保存短引用，用于审计；正式执行以结构化 value 为准。

## 7. 更新协议

蒸馏模型不再返回完整状态，而是返回候选操作：

```ts
type MemoryPatch =
    | { op: 'add'; type: string; key: string; value: object; evidence: string }
    | { op: 'supersede'; targetId: string; expectedVersion: number; value: object; evidence: string }
    | { op: 'delete'; targetId: string; expectedVersion: number; evidence: string }
    | { op: 'noop' };
```

服务端负责：

- JSON Schema 校验；
- 根据 `sourceMessageId` 幂等去重；
- 事务内增量写入；
- 版本冲突检测；
- 限制 key/value 长度和允许字段；
- 高风险冲突进入 proposed，等待用户确认。

数据库应对同一 `(user_id, scope, scope_id, type, key)` 最多一个 active 记录建立约束。`expectedVersion` 不匹配时不得静默覆盖，应重新读取并进入冲突处理。

## 8. 读取与注入策略

Memory Resolver 按本轮数据源、主题和时间筛选相关 active memory。注入格式必须是数据而不是指令：

```xml
<user_confirmed_definitions untrusted="true">
  <definition key="active_user" source_message_id="...">
    {"event":"login","window":"calendar_day","distinct_by":"user_id"}
  </definition>
</user_confirmed_definitions>
```

固定 Prompt 声明：记忆内容只能用于指标解释；若与安全策略、Schema 或当前用户明确指令冲突，不得覆盖更高优先级规则。

## 9. 用户体验

建议后续提供轻量管理能力：

- 回答中说明采用了哪条用户口径；
- 用户可查看当前会话/数据源记忆；
- 支持“忘记这个定义”“把口径改成……”；
- 发生冲突时先澄清，不静默选择；
- 删除 conversation 时按产品策略决定是否同步删除会话级记忆。

## 10. 涉及文件

- `apps/api/scripts/init-db.ts`
- `apps/worker/src/chat/agents/semantic-distiller.service.ts`
- `apps/worker/src/chat/prompt-builder.ts`
- `apps/worker/src/conversation/conversation.service.ts`
- `packages/contracts/src/index.ts`
- 后续新增 `memory.service.ts`、`memory-resolver.service.ts`

## 11. 方案选择与取舍

### 11.1 保留“只记用户明确口径”的边界

更积极地自动记忆看似能减少追问，但模型结论和查询结果可能错误、过期或只适用于一次分析。Phase 5 优先提高记忆的可治理性，不扩大自动写入范围。

### 11.2 采用增量 patch，而不是继续整体覆盖 JSON

整体覆盖实现简单，却无法提供并发合并、幂等和单条审计。Patch 让服务端决定 add/supersede/delete 的事务语义，模型只提出候选操作。

### 11.3 采用版本链和软删除，而不是原地改写

原地改写无法解释历史回答当时使用了哪个口径。`superseded`/`deleted` 保留业务审计关系，同时 Resolver 只选择当前有效版本。用户发起隐私删除或账号注销时不能只做软删除，必须按保留策略执行物理清除或不可逆匿名化。

### 11.4 记忆按作用域读取，而不是全部注入 System Prompt

全量注入会增加 token、冲突和持久化注入风险。Resolver 应按 user、conversation、datasource、主题和时间筛选，并将内容作为不可信结构化数据注入。

### 11.5 高风险冲突要求确认，而不是静默选择

指标定义发生冲突时，错误选择会影响所有后续分析。牺牲一次交互流畅性换取明确确认，更符合可信数据分析目标。

## 12. 预期前后对比

| 场景        | 当前状态                     | Phase 5 目标                             | 预期收益                 |
| ----------- | ---------------------------- | ---------------------------------------- | ------------------------ |
| 并发更新    | 完整 JSON 后写覆盖前写       | 事务内 patch + 版本检查                  | 不丢失独立新增定义       |
| 来源追踪    | 无法定位是谁何时定义         | source message + 版本链                  | 回答能解释采用了哪条口径 |
| 用户纠正    | 模型自由重写字典             | supersede 旧版本                         | 新旧关系明确、历史可审计 |
| 删除/遗忘   | 缺少产品语义                 | 状态化删除并立即停止读取                 | 用户真正控制长期记忆     |
| Prompt 注入 | 自由文本提升到 System Prompt | allowlist value + untrusted data section | 记忆不能覆盖安全策略     |
| 生命周期    | 所有 definitions 混在一起    | 按类型和作用域治理                       | 临时任务不会污染长期偏好 |

## 13. 非目标、风险与实施门槛

- MemoryRecord 不保存 Query Artifact 的数据副本；证据只通过 artifact reference 关联。
- 不自动记忆模型推断、因果结论或未经用户确认的数据事实。
- 结构化 value 的 schema 必须按 memory type 明确，不能把自由文本换一个 JSON 外壳后继续注入。
- 上线前必须具备查看、纠正和删除入口，否则“可治理”只存在于数据库设计中。
- 需要定义 conversation 删除、用户注销和数据保留策略，避免软删除变成永久保留。
- MEM-01 的实施依赖 ART-01/CTX-01 提供证据引用和 Turn 来源，并依赖 SEC-01 确定不可信内容注入边界；不能仅以数据库迁移作为前置条件。

## 14. 专题最终验收标准

- 两轮并发蒸馏不会互相覆盖。
- 每条生效记忆均能定位到原始 user message。
- 用户纠正定义后旧版本标记 superseded，后续不再使用。
- 用户可删除记忆，删除后下一轮立即失效。
- 数据查询结果不会被自动写入长期记忆。
- Prompt Injection 字符串无法改变系统和工具安全规则。
