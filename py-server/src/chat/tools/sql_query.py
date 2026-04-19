import asyncio
import json
from typing import Any

from chat.agents.sql_executor import SqlExecutorAgent
from chat.tools.base import Tool, ToolContext, ToolExecutionResult

MAX_TOOL_RESULT_CHARS = 60_000


class SqlQueryTool(Tool):
    def __init__(self, sql_executor: SqlExecutorAgent):
        self._executor = sql_executor

    @property
    def name(self) -> str:
        return "execute_sql_query"

    @property
    def definition(self) -> dict[str, Any]:
        return {
            "type": "function",
            "function": {
                "name": "execute_sql_query",
                "description": "执行 SELECT 语句读取数据。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "sql": {
                            "type": "string",
                            "description": "安全的只读 MySQL 查询语句",
                        }
                    },
                    "required": ["sql"],
                },
            },
        }

    async def execute(
        self, args: dict[str, Any], ctx: ToolContext
    ) -> ToolExecutionResult:
        sql = args.get("sql", "")
        blocks: list[dict] = []

        exec_log: dict = {
            "type": "log",
            "title": "[数据查询]",
            "content": "正在从数据库提取并处理结果...",
        }
        ctx.emitter.send(exec_log)
        blocks.append(exec_log)

        await asyncio.sleep(1)  # 增强"思考中"感知

        # 只有执行器本身抛的异常才算"SQL 执行出错"，返回给 LLM 自我修正。
        # 执行器之后的序列化 / SSE 推送若出错，是本服务自身的 bug，必须向上暴露，
        # 绝不能伪装成 SQL 错误让 LLM 瞎改（历史教训：date 序列化炸了，LLM 反复重写 SQL）。
        try:
            r = await self._executor.execute(sql, ctx.datasource_id, ctx.user_id)
        except Exception as e:
            exec_log["content"] = f"查询失败: {e}"
            ctx.emitter.send({**exec_log, "type": "log_update"})
            return ToolExecutionResult(
                tool_result=f"SQL 执行出错: {e}", blocks=blocks
            )

        if r.was_fixed:
            fix_log = {
                "type": "log",
                "title": "[防腐层自动修复]",
                "content": (
                    f"检测到语法错误已由内部子模型修复。\n修复前：{sql}\n\n"
                    f"修复后：{r.final_sql}"
                ),
            }
            ctx.emitter.send(fix_log)
            blocks.append(fix_log)

        exec_log["content"] = f"查询成功，共读取 {r.row_count} 条数据"
        ctx.emitter.send({**exec_log, "type": "log_update"})

        table_event = {
            "type": "table",
            "columns": r.columns,
            "rows": r.rows,
            "rowCount": r.row_count,
        }
        ctx.emitter.send(table_event)
        blocks.append(table_event)

        # 超长截断：按平均行长度估算，保留尽可能多行
        result_rows = r.rows
        truncation_note = ""
        serialized = json.dumps(result_rows, ensure_ascii=False, default=str)
        if len(serialized) > MAX_TOOL_RESULT_CHARS and len(result_rows) > 1:
            avg_size = len(serialized) / len(result_rows)
            fit_count = max(1, int(MAX_TOOL_RESULT_CHARS / avg_size))
            result_rows = r.rows[:fit_count]
            truncation_note = (
                f"\n[注意：完整查询共 {r.row_count} 条，因数据体积超限"
                f"仅提供前 {fit_count} 条用于分析，请在结论中注明数据未完整展示。]"
            )

        if r.was_fixed:
            tool_result = json.dumps(
                {
                    "systemMessage": (
                        f"注意：由于你写的原始 SQL 存在特定语法错误，已被系统防腐代理自动拦截修复！"
                        f"最终成功执行的 SQL 为: {r.final_sql}。请在最终结论中以此为准。"
                        f"{truncation_note}"
                    ),
                    "data": result_rows,
                },
                ensure_ascii=False,
                default=str,
            )
        elif truncation_note:
            tool_result = json.dumps(
                {"systemMessage": truncation_note.strip(), "data": result_rows},
                ensure_ascii=False,
                default=str,
            )
        else:
            tool_result = json.dumps(
                result_rows, ensure_ascii=False, default=str
            )

        return ToolExecutionResult(tool_result=tool_result, blocks=blocks)
