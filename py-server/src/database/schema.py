import time
from typing import Any

from database.service import DatabaseService

PRESET_BUSINESS_TABLES = ["platform_info", "daily_active_stats", "user_behavior_log"]
CACHE_TTL_MS = 60 * 1000  # 1 minute


class SchemaService:
    def __init__(self, db: DatabaseService):
        self._db = db
        # A simple in-memory map cache per process.
        # In a real distributed deployment, use Redis, but here it perfectly matches the original NestJS logic.
        self._cache: dict[str, dict[str, Any]] = {}

    async def get_database_schema_prompt(
        self, datasource_id: int | None, user_id: int
    ) -> str:
        cache_key = f"{datasource_id or 'local'}_{user_id}"
        cached = self._cache.get(cache_key)
        if cached and (time.time() * 1000 - cached["timestamp"]) < CACHE_TTL_MS:
            return cached["prompt"]

        is_internal = await self._is_internal_ds(datasource_id)
        uploaded_table_names = await self._get_user_uploaded_table_names(
            datasource_id, user_id
        )

        allowed_tables = (
            PRESET_BUSINESS_TABLES + uploaded_table_names
            if is_internal
            else uploaded_table_names
        )

        if not allowed_tables:
            return (
                "当前数据库中没有可用的业务表。"
                if is_internal
                else "当前数据源中还没有上传的表。"
            )

        prompt = await self._fetch_schema_prompt_from_local(
            allowed_tables, uploaded_table_names
        )
        if prompt:
            self._cache[cache_key] = {"prompt": prompt, "timestamp": time.time() * 1000}

        return prompt

    def clear_user_cache(self, datasource_id: int | None, user_id: int) -> None:
        cache_key = f"{datasource_id or 'local'}_{user_id}"
        self._cache.pop(cache_key, None)

    async def get_allowed_table_names(
        self, datasource_id: int | None, user_id: int
    ) -> list[str]:
        is_internal = await self._is_internal_ds(datasource_id)
        uploaded_table_names = await self._get_user_uploaded_table_names(
            datasource_id, user_id
        )

        if is_internal:
            return PRESET_BUSINESS_TABLES + uploaded_table_names
        return uploaded_table_names

    async def _is_internal_ds(self, datasource_id: int | None) -> bool:
        if not datasource_id:
            return True
        rows = await self._db.query(
            "SELECT is_local FROM data_source WHERE id = %s", (datasource_id,)
        )
        if not rows:
            return True
        return bool(rows[0]["is_local"])

    async def _get_user_uploaded_table_names(
        self, datasource_id: int | None, user_id: int
    ) -> list[str]:
        actual_datasource_id = datasource_id
        if actual_datasource_id is None:
            actual_datasource_id = await self._get_local_datasource_id()
        if not actual_datasource_id:
            return []

        rows = await self._db.query(
            "SELECT table_name FROM uploaded_table WHERE datasource_id = %s",
            (actual_datasource_id,),
        )
        return [r["table_name"] for r in rows]

    async def _get_local_datasource_id(self) -> int | None:
        rows = await self._db.query(
            "SELECT id FROM data_source WHERE is_local = 1 LIMIT 1"
        )
        return rows[0]["id"] if rows else None

    async def _fetch_schema_prompt_from_local(
        self, allowed_tables: list[str], uploaded_table_names: list[str]
    ) -> str:
        rows = await self._db.query("SELECT DATABASE() AS db_name")
        db_name = rows[0].get("db_name") if rows else None
        if not db_name:
            return "无法获取目标数据库名称。"

        placeholders = ", ".join(["%s"] * len(allowed_tables))
        sql = f"""
            SELECT
                c.TABLE_NAME,
                t.TABLE_COMMENT,
                c.COLUMN_NAME,
                c.COLUMN_TYPE,
                c.COLUMN_COMMENT
            FROM information_schema.COLUMNS c
            JOIN information_schema.TABLES t
              ON c.TABLE_NAME = t.TABLE_NAME AND c.TABLE_SCHEMA = t.TABLE_SCHEMA
            WHERE c.TABLE_SCHEMA = %s
              AND c.TABLE_NAME IN ({placeholders})
            ORDER BY c.TABLE_NAME, c.ORDINAL_POSITION
        """
        params = [db_name] + allowed_tables
        col_rows = await self._db.query(sql, params)
        return self._format_schema_rows(col_rows, uploaded_table_names)

    async def get_structured_schema(
        self, datasource_id: int | None, user_id: int
    ) -> list[dict]:
        is_internal = await self._is_internal_ds(datasource_id)
        uploaded_table_names = await self._get_user_uploaded_table_names(
            datasource_id, user_id
        )

        allowed_tables = (
            PRESET_BUSINESS_TABLES + uploaded_table_names
            if is_internal
            else uploaded_table_names
        )

        if not allowed_tables:
            return []

        rows = await self._db.query("SELECT DATABASE() AS db_name")
        db_name = rows[0].get("db_name") if rows else None
        if not db_name:
            return []

        placeholders = ", ".join(["%s"] * len(allowed_tables))
        sql = f"""
            SELECT
                c.TABLE_NAME,
                t.TABLE_COMMENT,
                c.COLUMN_NAME,
                c.COLUMN_TYPE,
                c.COLUMN_COMMENT
            FROM information_schema.COLUMNS c
            JOIN information_schema.TABLES t
              ON c.TABLE_NAME = t.TABLE_NAME AND c.TABLE_SCHEMA = t.TABLE_SCHEMA
            WHERE c.TABLE_SCHEMA = %s
              AND c.TABLE_NAME IN ({placeholders})
            ORDER BY c.TABLE_NAME, c.ORDINAL_POSITION
        """
        params = [db_name] + allowed_tables
        col_rows = await self._db.query(sql, params)

        tables_map = {}
        for row in col_rows:
            table_name = row["TABLE_NAME"]
            if table_name not in tables_map:
                tables_map[table_name] = {
                    "tableName": table_name,
                    "display_name": row["TABLE_COMMENT"] or table_name,
                    "isUploaded": table_name in uploaded_table_names,
                    "fields": [],
                }
            tables_map[table_name]["fields"].append(
                {
                    "name": row["COLUMN_NAME"],
                    "type": row["COLUMN_TYPE"],
                    "comment": row["COLUMN_COMMENT"] or "",
                }
            )

        return list(tables_map.values())

    def _format_schema_rows(
        self, rows: list[dict], uploaded_table_names: list[str]
    ) -> str:
        if not rows:
            return "当前数据库中没有可用的业务表。"

        tables_map = {}
        for row in rows:
            table_name = row["TABLE_NAME"]
            if table_name not in tables_map:
                tables_map[table_name] = {
                    "comment": row["TABLE_COMMENT"] or "",
                    "columns": [],
                    "isUploaded": table_name in uploaded_table_names,
                }
            col_def = f"  {row['COLUMN_NAME']} {row['COLUMN_TYPE']} -- {row['COLUMN_COMMENT'] or ''}"
            tables_map[table_name]["columns"].append(col_def)

        prompt_lines = []
        for table_name, info in tables_map.items():
            label = " [用户上传]" if info["isUploaded"] else ""
            prompt_lines.append(f"表名: {table_name}{label}")
            prompt_lines.append(f"说明: {info['comment']}")
            columns_str = "\n".join(info["columns"])
            prompt_lines.append(f"字段:\n{columns_str}")
            prompt_lines.append("")

        return "\n".join(prompt_lines).strip()
