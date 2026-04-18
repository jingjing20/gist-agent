import logging
import random
import time
from typing import Any

from fastapi import HTTPException

from database.schema import SchemaService
from database.service import DatabaseService
from datasource.schema_enrichment import SchemaEnrichmentService

logger = logging.getLogger(__name__)


class DataSourceService:
    """对齐 Nest DataSourceService：
    权限模型三层：
      1. 公共 (created_by = NULL) -> 所有用户可见
      2. 自建 (created_by = userId) -> 创建者全权
      3. 授权 (datasource_permission 表) -> grant/revoke 管理
    """

    def __init__(
        self,
        db: DatabaseService,
        schema_service: SchemaService,
        enrichment_service: SchemaEnrichmentService,
    ):
        self._db = db
        self._schema = schema_service
        self._enrichment = enrichment_service

    async def can_access(self, datasource_id: int, user_id: int) -> bool:
        """公共 -> 自建 -> 被授权，三级短路。"""
        rows = await self._db.query(
            "SELECT created_by FROM data_source WHERE id = %s", (datasource_id,)
        )
        if not rows:
            return False
        created_by = rows[0]["created_by"]
        if created_by is None:
            return True
        if created_by == user_id:
            return True
        perm = await self._db.query(
            "SELECT 1 FROM datasource_permission WHERE datasource_id = %s AND user_id = %s",
            (datasource_id, user_id),
        )
        return bool(perm)

    async def find_all_for_user(self, user_id: int) -> list[dict]:
        return await self._db.query(
            """
            SELECT d.id, d.name, d.is_local, d.created_by, u.name as creator_name,
                   d.description, d.created_at
            FROM data_source d
            LEFT JOIN user u ON d.created_by = u.id
            LEFT JOIN datasource_permission p ON d.id = p.datasource_id AND p.user_id = %s
            WHERE d.created_by IS NULL OR d.created_by = %s OR p.user_id IS NOT NULL
            ORDER BY d.id ASC
            """,
            (user_id, user_id),
        )

    async def find_one(self, ds_id: int, user_id: int) -> dict:
        if not await self.can_access(ds_id, user_id):
            raise HTTPException(status_code=403, detail="无权访问此数据源")
        rows = await self._db.query(
            "SELECT id, name, is_local, created_by, description, created_at "
            "FROM data_source WHERE id = %s",
            (ds_id,),
        )
        if not rows:
            raise HTTPException(status_code=404, detail=f"数据源 id={ds_id} 不存在")
        return rows[0]

    async def create(self, user_id: int, name: str, description: str | None) -> dict:
        insert_id = await self._db.execute(
            "INSERT INTO data_source (name, created_by, description) VALUES (%s, %s, %s)",
            (name, user_id, description),
        )
        # 创建者自动获得权限记录（与 Nest 一致）
        await self._db.execute(
            "INSERT INTO datasource_permission (datasource_id, user_id, granted_by) "
            "VALUES (%s, %s, %s)",
            (insert_id, user_id, None),
        )
        return await self.find_one(insert_id, user_id)

    async def update(
        self, ds_id: int, user_id: int, name: str | None, description: str | None
    ) -> dict:
        ds = await self.find_one(ds_id, user_id)
        if ds["created_by"] != user_id:
            raise HTTPException(status_code=403, detail="仅创建人可编辑数据源信息")

        fields: list[str] = []
        values: list[Any] = []
        if name is not None:
            fields.append("name = %s")
            values.append(name)
        if description is not None:
            fields.append("description = %s")
            values.append(description)

        if fields:
            values.append(ds_id)
            await self._db.execute(
                f"UPDATE data_source SET {', '.join(fields)} WHERE id = %s",
                tuple(values),
            )

        return await self.find_one(ds_id, user_id)

    async def remove(self, ds_id: int, user_id: int) -> None:
        rows = await self._db.query(
            "SELECT is_local, created_by FROM data_source WHERE id = %s", (ds_id,)
        )
        if not rows:
            raise HTTPException(status_code=404, detail=f"数据源 id={ds_id} 不存在")
        row = rows[0]
        if row["is_local"]:
            raise HTTPException(status_code=400, detail="默认本地库不可删除")
        if row["created_by"] != user_id:
            raise HTTPException(status_code=403, detail="仅创建人可删除")

        table_rows = await self._db.query(
            "SELECT table_name FROM uploaded_table WHERE datasource_id = %s", (ds_id,)
        )
        for t in table_rows:
            await self._db.execute(f"DROP TABLE IF EXISTS `{t['table_name']}`")

        await self._db.execute("DELETE FROM data_source WHERE id = %s", (ds_id,))
        self._schema.clear_user_cache(ds_id, user_id)

    async def upload_table(
        self,
        datasource_id: int,
        user_id: int,
        display_name: str,
        columns: list[dict],
        rows: list[dict],
    ) -> dict:
        """文件上传建表核心流程（与 Nest 对齐）：
        1. CREATE TABLE (动态列定义)
        2. 批量 INSERT
        3. ALTER TABLE 写入表/列注释 (原始列名 -> COMMENT，供 LLM 理解业务语义)
        4. 异步触发: Schema 增强 (LLM 推断业务语义)
        """
        ds = await self.find_one(datasource_id, user_id)
        if ds["is_local"] == 1:
            raise HTTPException(
                status_code=403, detail="公共默认数据源不支持上传文件"
            )
        if not columns:
            raise HTTPException(status_code=400, detail="文件不包含有效列")

        import re

        safe_re = re.compile(r"^[a-zA-Z_\u4e00-\u9fff][a-zA-Z0-9_\u4e00-\u9fff]*$")
        for col in columns:
            if not safe_re.match(col["name"]):
                raise HTTPException(
                    status_code=400,
                    detail=f"列名 \"{col['name']}\" 包含非法字符，仅允许字母、数字、下划线和中文",
                )

        # ut_{timestamp_ms}_{random6}，与 Nest Date.now() + Math.random() 对齐
        rand_suffix = "".join(
            random.choice("0123456789abcdefghijklmnopqrstuvwxyz") for _ in range(6)
        )
        table_name = f"ut_{int(time.time() * 1000)}_{rand_suffix}"

        col_defs = ", ".join([f"`{c['name']}` {c['type']}" for c in columns])
        await self._db.execute(f"CREATE TABLE `{table_name}` ({col_defs})")

        try:
            # 批量 INSERT：每行参数数 ≈ 60000 / 列数，防止 packet 过大
            if rows:
                batch = max(1, 60000 // len(columns))
                col_list = ", ".join([f"`{c['name']}`" for c in columns])
                row_ph = "(" + ", ".join(["%s"] * len(columns)) + ")"
                for i in range(0, len(rows), batch):
                    chunk = rows[i : i + batch]
                    placeholders = ", ".join([row_ph] * len(chunk))
                    values: list = []
                    for r in chunk:
                        for c in columns:
                            v = r.get(c["name"])
                            values.append(v if v is not None else None)
                    await self._db.execute(
                        f"INSERT INTO `{table_name}` ({col_list}) VALUES {placeholders}",
                        tuple(values),
                    )

            # 表/列 COMMENT 写入：originalName 优先于 name，供 LLM 理解字段语义
            await self._db.execute(
                f"ALTER TABLE `{table_name}` COMMENT = %s", (display_name,)
            )
            for col in columns:
                comment = col.get("originalName") or col["name"]
                await self._db.execute(
                    f"ALTER TABLE `{table_name}` MODIFY `{col['name']}` {col['type']} COMMENT %s",
                    (comment,),
                )

            insert_id = await self._db.execute(
                "INSERT INTO uploaded_table (datasource_id, user_id, table_name, display_name) "
                "VALUES (%s, %s, %s, %s)",
                (datasource_id, user_id, table_name, display_name),
            )

            self._schema.clear_user_cache(datasource_id, user_id)
            self._enrichment.enrich_table_schema_async(table_name)

            from datetime import datetime, timezone

            return {
                "id": insert_id,
                "datasource_id": datasource_id,
                "user_id": user_id,
                "table_name": table_name,
                "display_name": display_name,
                "created_at": datetime.now(timezone.utc).isoformat(),
            }
        except Exception:
            await self._db.execute(f"DROP TABLE IF EXISTS `{table_name}`")
            raise

    async def list_uploaded_tables(self, ds_id: int, user_id: int) -> list[dict]:
        await self.find_one(ds_id, user_id)
        return await self._db.query(
            """
            SELECT t.id, t.datasource_id, t.user_id, u.name as uploader_name,
                   t.table_name, t.display_name, t.created_at
            FROM uploaded_table t
            LEFT JOIN user u ON t.user_id = u.id
            WHERE t.datasource_id = %s
            ORDER BY t.created_at DESC
            """,
            (ds_id,),
        )

    async def delete_uploaded_table(self, table_id: int, user_id: int) -> int | None:
        rows = await self._db.query(
            """
            SELECT t.table_name, t.user_id, t.datasource_id, d.created_by as ds_creator_id
            FROM uploaded_table t
            LEFT JOIN data_source d ON t.datasource_id = d.id
            WHERE t.id = %s
            """,
            (table_id,),
        )
        if not rows:
            raise HTTPException(status_code=404, detail=f"上传表 id={table_id} 不存在")
        row = rows[0]
        if row["user_id"] != user_id and row["ds_creator_id"] != user_id:
            raise HTTPException(
                status_code=403, detail="仅数据源创建者或表上传人可删除"
            )

        await self._db.execute(f"DROP TABLE IF EXISTS `{row['table_name']}`")
        await self._db.execute(
            "DELETE FROM uploaded_table WHERE id = %s", (table_id,)
        )
        self._schema.clear_user_cache(row["datasource_id"], user_id)
        return row["datasource_id"]

    async def get_uploaded_table_names(
        self, datasource_id: int, _user_id: int
    ) -> list[str]:
        rows = await self._db.query(
            "SELECT table_name FROM uploaded_table WHERE datasource_id = %s",
            (datasource_id,),
        )
        return [r["table_name"] for r in rows]

    async def grant(self, ds_id: int, target_user_id: int, grantor_id: int) -> None:
        rows = await self._db.query(
            "SELECT created_by FROM data_source WHERE id = %s", (ds_id,)
        )
        if not rows:
            raise HTTPException(
                status_code=404, detail=f"数据源 id={ds_id} 不存在"
            )
        if rows[0]["created_by"] != grantor_id:
            raise HTTPException(status_code=403, detail="仅创建人可授权")
        await self._db.execute(
            "INSERT IGNORE INTO datasource_permission (datasource_id, user_id, granted_by) "
            "VALUES (%s, %s, %s)",
            (ds_id, target_user_id, grantor_id),
        )

    async def revoke(self, ds_id: int, target_user_id: int, grantor_id: int) -> None:
        rows = await self._db.query(
            "SELECT created_by FROM data_source WHERE id = %s", (ds_id,)
        )
        if not rows:
            raise HTTPException(
                status_code=404, detail=f"数据源 id={ds_id} 不存在"
            )
        if rows[0]["created_by"] != grantor_id:
            raise HTTPException(status_code=403, detail="仅创建人可撤销授权")
        await self._db.execute(
            "DELETE FROM datasource_permission "
            "WHERE datasource_id = %s AND user_id = %s",
            (ds_id, target_user_id),
        )

    async def list_permission_users(
        self, ds_id: int, grantor_id: int
    ) -> list[dict]:
        rows = await self._db.query(
            "SELECT created_by FROM data_source WHERE id = %s", (ds_id,)
        )
        if not rows:
            raise HTTPException(
                status_code=404, detail=f"数据源 id={ds_id} 不存在"
            )
        if rows[0]["created_by"] != grantor_id:
            raise HTTPException(
                status_code=403, detail="仅创建人可查看授权列表"
            )
        return await self._db.query(
            """
            SELECT u.id, u.email, u.name FROM user u
            INNER JOIN datasource_permission p
              ON u.id = p.user_id AND p.datasource_id = %s
            ORDER BY u.email
            """,
            (ds_id,),
        )
