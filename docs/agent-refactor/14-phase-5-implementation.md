# Phase 5 决策与实施记录：结构化记忆

> 阶段状态：已完成
>
> 完成日期：2026-09-18

## 1. 阶段结论

Phase 5 将 conversation 上的自由 `semantic_state` 整体覆盖替换为独立 `memory_record`。每条记忆有用户、作用域、类型、结构化值、原始 user message、短引用、状态和版本；模型只能提出 patch，服务端负责 schema、安全、幂等、并发和事务语义。

## 2. 核心不变量

- 只从本轮 user message 提取用户明确陈述的口径或长期偏好。
- 查询结果、模型推断、因果结论和临时任务不得进入长期记忆。
- 每条记录必须关联原始 user message；记忆值不能携带指令或越权要求。
- 同一用户、作用域、类型和 key 最多一条 active 记录。
- 更新必须携带 expectedVersion；高风险或并发冲突进入 proposed，不静默覆盖。
- Resolver 只读取 active 且未过期的相关 user/datasource/conversation 记忆。

## 3. 实现与取舍

- `memory_record` 保存版本链，`superseded` 和 `deleted` 立即退出 Resolver；`memory_change_audit` 记录管理入口的确认、纠正和遗忘。
- add 在事务中获取逻辑 key 的 advisory lock，不同 key 可并行，同 key 串行判断 active/proposed，避免后写覆盖或静默丢失。
- supersede 锁定目标并检查版本；过期版本的纠正候选进入 proposed，等待用户确认。
- 结构化 value 按类型使用字段 allowlist，并限制 key、引用和序列化大小；明显的持久化注入文本在写入前拒绝。
- Prompt 以 `user-confirmed-memory untrusted="true"` JSON 数据区注入，并明确不能改变系统、安全、Schema 或工具规则。
- API 提供列表、确认、纠正和遗忘接口；Web 用户菜单提供“记忆管理”界面。

项目尚未正式上线，因此本阶段按用户决策不迁移、不兼容旧 `semantic_state`，初始化迁移直接删除该列。conversation 删除会通过 source message 外键级联删除源自该对话的记忆，优先保证隐私删除完整性。

## 4. API

- `GET /api/memories`：查看 active 与 proposed。
- `POST /api/memories/:id/confirm`：确认冲突候选，要求 `expectedVersion`。
- `PATCH /api/memories/:id`：以新结构化 value 纠正 active 记录。
- `DELETE /api/memories/:id`：遗忘 active/proposed 记录并立即停止解析。

所有操作按当前登录用户隔离；版本不匹配返回稳定的 `MEMORY_VERSION_CONFLICT` 消息。

## 5. 验证

| 命令 | 覆盖 | 结果 |
| --- | --- | --- |
| `pnpm test:phase5` | Schema 约束、patch 解析、禁止数据事实类型、注入拒绝、Prompt 不可信边界、版本升级 | PASS |
| `node scripts/phase4-security-quality-regression.mjs` | Phase 4 Schema/记忆注入边界回归 | PASS |
| API、Worker、Web build | TypeScript、Nest 编译和前端生产构建 | PASS |

遵循仓库约定，未运行浏览器交互 E2E 和完整回归。

## 6. 未解决问题

- 记忆语义召回目前按作用域和类型确定性筛选，不做向量检索；百表/大规模上下文优化由 Phase 6 承接。
- 自动提取依赖模型，错误候选仍可能需要用户在管理界面确认或纠正；Phase 6 应把提取准确率纳入评测。
- 账号注销的跨系统清理、法务保留期和不可逆匿名化属于产品级数据保留策略，由 Phase 6 统一落地。
