"""三防线 SQL 执行器：
  1. validate()   - AST 白名单 + 表访问控制（拒绝非 SELECT/SHOW/DESC/EXPLAIN）
  2. ensure_limit() - 自动注入 LIMIT 1000，阻止 LLM 一次性拉全表
  3. query_with_timeout() - 客户端超时熔断
语法错误由小模型静默修复（最多 2 次）；语义错误直接暴露给主 LLM。
"""

import asyncio
import logging
import re
from dataclasses import dataclass
from typing import Any

import sqlglot
from sqlglot import exp

from database.schema import SchemaService
from database.service import DatabaseService
from llm.service import LlmService

logger = logging.getLogger(__name__)

MAX_ROWS = 1000
QUERY_TIMEOUT_SECONDS = 15

# 纯语法 / 方言错误：小模型可安全修复
SYNTAX_ERROR_CODES = {
    1064,  # ER_PARSE_ERROR
    1055,  # ER_WRONG_FIELD_WITH_GROUP (ONLY_FULL_GROUP_BY)
    1140,  # ER_MIX_OF_GROUP_FUNC_AND_FIELDS
    1116,  # ER_TOO_MANY_TABLES
    1052,  # ER_NON_UNIQ_ERROR (模糊列引用)
}

# 沿用 Nest 注释中的原因：AST 解析异常也视作语法错误
_AST_PARSE_ERROR = "ER_PARSE_ERROR"


@dataclass
class QueryResult:
    final_sql: str
    was_fixed: bool
    columns: list[str]
    rows: list[dict[str, Any]]
    row_count: int


class SqlSyntaxError(Exception):
    """仅用于标记可由小模型修复的语法类错误。"""

    def __init__(self, message: str, code: Any = _AST_PARSE_ERROR):
        super().__init__(message)
        self.code = code


class SqlExecutorAgent:
    def __init__(
        self,
        db: DatabaseService,
        llm: LlmService,
        schema_service: SchemaService,
    ):
        self._db = db
        self._llm = llm
        self._schema = schema_service

    async def execute(
        self,
        sql: str,
        datasource_id: int | None = None,
        user_id: int | None = None,
    ) -> QueryResult:
        max_retries = 2
        current_sql = sql
        attempt = 0

        allowed_tables: list[str] | str = "ALL"
        if user_id is not None:
            allowed_tables = await self._schema.get_allowed_table_names(
                datasource_id, user_id
            )

        while attempt <= max_retries:
            try:
                ast = self._validate(current_sql, allowed_tables)
                safe_sql = self._ensure_limit(ast)

                rows = await self._query_with_timeout(safe_sql)

                if allowed_tables != "ALL" and self._is_show_tables(safe_sql):
                    rows = self._filter_show_tables_rows(rows, allowed_tables)  # type: ignore[arg-type]

                columns = list(rows[0].keys()) if rows else []
                return QueryResult(
                    final_sql=safe_sql,
                    was_fixed=(current_sql != sql),
                    columns=columns,
                    rows=rows,
                    row_count=len(rows),
                )
            except Exception as e:
                attempt += 1
                code = getattr(e, "code", None) or getattr(
                    getattr(e, "args", [None])[0] if e.args else None, "code", None
                )
                # aiomysql OperationalError 形如 (1064, 'msg')
                if code is None and hasattr(e, "args") and e.args:
                    if isinstance(e.args[0], int):
                        code = e.args[0]

                is_syntax = isinstance(e, SqlSyntaxError) or (
                    code in SYNTAX_ERROR_CODES
                )

                if is_syntax and attempt <= max_retries:
                    logger.warning(
                        f"检测到 SQL 语法错误 (code={code})，启动内部小模型修复 "
                        f"(第 {attempt} 次)..."
                    )
                    try:
                        current_sql = await self._attempt_fix_sql(
                            current_sql, str(e)
                        )
                        logger.info(f"小模型修复完成: {current_sql}")
                        continue
                    except Exception as fix_err:
                        logger.error(f"小模型修复 SQL 失败: {fix_err}")
                        raise e

                # 语义错误或达到上限：直接暴露
                logger.error(f"SQL 执行异常，暴露给上层: {e}")
                raise

        raise RuntimeError("超出最大 SQL 执行重试限制")

    def _validate(
        self, sql: str, allowed_tables: list[str] | str = "ALL"
    ) -> list[exp.Expression]:
        """AST 白名单：仅放行只读操作，并按 allowed_tables 做访问控制。"""
        try:
            parsed = sqlglot.parse(sql, read="mysql")
            parsed = [p for p in parsed if p is not None]
        except Exception as e:
            raise SqlSyntaxError(f"[AST 解析异常] {e}")

        if not parsed:
            raise SqlSyntaxError("[AST 解析异常] 空 SQL")

        # 白名单：Select / Show / Describe(覆盖 EXPLAIN/DESC)
        allowed_types = (exp.Select, exp.Show, exp.Describe)

        for node in parsed:
            if not isinstance(node, allowed_types):
                type_name = node.key.lower() if hasattr(node, "key") else type(
                    node
                ).__name__.lower()
                raise PermissionError(
                    f"安全阻断：探测到非法的 [{type_name}] 操作。"
                    "当前被限制为纯只读探查模式，禁止可能的数据修改或越权操作！"
                )

        if allowed_tables != "ALL":
            allowed_lower = {t.lower() for t in allowed_tables}
            for node in parsed:
                for table in node.find_all(exp.Table):
                    name = (table.name or "").lower().strip("`")
                    if name and name not in allowed_lower:
                        raise PermissionError(
                            f"安全阻断：探测到越权访问。表 [{name}] "
                            "不在当前数据源的允许范围内。"
                        )

        return parsed

    def _ensure_limit(self, ast_list: list[exp.Expression]) -> str:
        """SELECT 缺 LIMIT 则注入 LIMIT 1000。"""
        modified_parts = []
        for node in ast_list:
            # 仅对纯 SELECT 注入；子查询由 LIMIT 天然限制父查询行数
            if isinstance(node, exp.Select) and not node.args.get("limit"):
                node = node.limit(MAX_ROWS)
            modified_parts.append(node.sql(dialect="mysql"))

        return "; ".join(modified_parts)

    async def _query_with_timeout(self, sql: str) -> list[dict]:
        try:
            return await asyncio.wait_for(
                self._db.query(sql), timeout=QUERY_TIMEOUT_SECONDS
            )
        except asyncio.TimeoutError:
            raise TimeoutError(
                f"查询超时（> {QUERY_TIMEOUT_SECONDS}s），已自动熔断拦截"
            )

    @staticmethod
    def _is_show_tables(sql: str) -> bool:
        return bool(re.match(r"^\s*SHOW\s+(FULL\s+)?TABLES", sql, re.IGNORECASE))

    @staticmethod
    def _filter_show_tables_rows(
        rows: list[dict], allowed_tables: list[str]
    ) -> list[dict]:
        allowed_set = set(allowed_tables)
        result = []
        for row in rows:
            if not row:
                continue
            first_val = next(iter(row.values()))
            if isinstance(first_val, str) and first_val in allowed_set:
                result.append(row)
        return result

    async def _attempt_fix_sql(self, original_sql: str, error_message: str) -> str:
        system_prompt = (
            "你是一个顶尖的 MySQL 数据分析工程师。你的任务是修复一段报错的 SQL 语句。"
            "由于你是在一个自动拦截防腐层内运行，你的上下文中没有完整的数据库 Schema。"
            "因此，你 **绝不能** 随意猜测或编造表名、字段名，你只能仅就 SQL 的**语法层面**"
            "进行修复（例如修改 GROUP BY、修复标点符号、处理严格模式等）。\n\n"
            "你 **必须且只能** 返回修复后的并且可以直接在 MySQL 8.0 运行的纯 SQL 代码。\n"
            "不要返回任何 markdown 格式（例如 ```sql），不要加任何解释，不要包含多余的话语。"
        )
        user_prompt = f"原始 SQL:\n{original_sql}\n\nMySQL 报错信息:\n{error_message}"

        response = await self._llm.chat(system_prompt, user_prompt, temperature=0)
        cleaned = re.sub(r"```sql", "", response, flags=re.IGNORECASE)
        cleaned = cleaned.replace("```", "").strip()
        return cleaned
