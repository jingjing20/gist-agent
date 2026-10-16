# ADR-002：分析草稿与Generation完成事务共同提交

## 状态与日期

现状有效；2026-10-14逆向记录。已验证`5a6b8f6`（2026-09-21）历史源码有相同提交约束；这只是可观察实现时间，不能认定为原始决策批准日期。

## 背景与决策

同一会话需要保留可被后续分析继承的状态，又会遇到取消、失败和版本竞争。当前每generation写analysis_state_draft，只有执行层completed时，Worker finalize的同一数据库事务调用promoteAnalysisDraft，将草稿提升为analysis_state。

## 可证的理由

[analysis-state-schema.ts](../../packages/database/src/analysis-state-schema.ts)注释明确要求“Must run inside the same transaction that commits generation completed.”，并说明锁conversation是为了“serialize the absent-row case as well as existing state”。`5a6b8f6`历史源码中存在同一约束与会话锁说明。

当前[states.history](../../apps/worker/src/analysis/analysis-state.repository.ts)说明仅completed Turn作为历史，失败草稿排除。证据支持一致性与并发序列化意图；不支持还原评审中是否比较过事件溯源或外部工作流引擎。

## 实现与权衡

base_revision与现state revision必须一致；不一致抛ANALYSIS_STATE_CONFLICT使finalize回滚，壳层转failed而不是发布不一致成功状态。failed/cancelled草稿保留但不提升，下一轮不继承其中未提交条件。

可观察代价是草稿与已提交状态两套存储和额外事务/行锁；状态冲突需重新分析。业务partial或awaiting_clarification仍可能completed并提升状态，不能只以complete判断是否提交。正式Memory写入是独立知识动作，不受此草稿回滚机制控制。

## 备选

没有可靠资料证明历史备选，不记录虚构比较。

## 关联

[数据模型设计](../design/data-model.md)、[状态指南](../guides/context-and-state.md)、[Generation生命周期](../guides/generation-lifecycle.md)。
