Hi ZhiHao,

全部 16 项改完，应用干净装配（32 路由），lint 零错。关键对齐点：

**基础设施**
- `SchemaService` 挂到 `app.state`，单例共享（原来每次请求 new 实例导致 1 分钟缓存失效）
- `get_schema_service` 从 `request.app.state` 取单例
- `LLMService` 重命名为 `LlmService` 与 Nest 一致

**鉴权/对话**
- `users/search` 加 `Depends(get_current_user)`
- `conversation` schema 补 `blocks` / `llm_messages` / 兼容迁移；`add_message` 返回完整对象；`update_title` 接受 `datasource_id`；默认标题 `"新对话"`；`get_messages` 支持 `message.blocks` JSON 回退
- 删掉多余 `GET /conversations/:id`

**数据源**
- `create` 签名改为 `(name, description)`，`created_by=user_id` 自动写入、创建者自动获 `datasource_permission`
- `find_all_for_user` 只返 Nest 字段集合，`ORDER BY id ASC`
- `upload_table` 改为接收 `columns + rows`（解析逻辑全移到 router）；批量 INSERT；写入表/列 COMMENT（用 originalName）；完成后触发 schema enrichment
- router 的 `upload_table` 完整实现 `normalizeValue / isNumeric / inferMysqlType / coerce / ensureUniqueColumnNames`，支持多 sheet、50k 行上限、20MB 文件上限
- `delete_uploaded_table` / `upload_table` 都会 `invalidate_and_regenerate` 建议
- `grant` 用 `INSERT IGNORE` 替代裸 `try/except`
- `SchemaEnrichmentService` 签名改回 `enrich_table_schema_async(table_name)`，prompt/JSON 结构与 Nest 对齐
- `SuggestionService` 补全 `trigger_async / invalidate_and_regenerate`，prompt 与 Nest 完全一致

**Chat 核心**
- `prompt_builder` 实现 Full/Medium/Compact 三级压缩 + 距离窗口（FULL_WINDOW=2, MEDIUM_WINDOW=6）+ 工具结果脱水 + 图表参数剥离；system prompt 按 Nest 严格输出中文工作流
- `token_estimator` 常量对齐（CJK 1.2 / ASCII 4 / overhead 4）
- `sql_executor` 改为 sqlglot AST 白名单（Select/Show/Describe）+ 动态表访问控制 + `LIMIT 1000` 注入 + 15s 超时 + 语法/语义错误区分（MySQL 错误码 1064/1055/1140/1116/1052 允许自动修，其他直接暴露）
- `semantic_distiller` 签名改为 `update_state_async(conv_id, user_id, user_message)`，prompt 对齐，仅从用户输入蒸馏口径
- `sql_query` 工具补 `MAX_TOOL_RESULT_CHARS=60000` 截断、`log_update`、`chart_loading`、`was_fixed` 修复提示
- `chat.service` 主循环完全对齐：`Promise.race` -> `asyncio.wait_for`、新对话自动从首条消息生成标题、即使超时/出错也持久化 assistant 消息（blocks+turnMessages 保 context）、`datasource_id` 从请求参数传而不是从 conversation 取
- `chat.router` 校验 message / conversationId 非空，补 SSE headers（`X-Accel-Buffering: no` 防 nginx 缓冲）

**行为变更验证**
- SELECT/SHOW/EXPLAIN/DESCRIBE 通过，DELETE/UPDATE/DROP/INSERT 阻断
- 表白名单跨表访问阻断
- LIMIT 自动注入 1000，已有 LIMIT 保留
