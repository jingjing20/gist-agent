import json
import logging
import uuid
from typing import Any

from fastapi import HTTPException

from database.service import DatabaseService

logger = logging.getLogger(__name__)

DEFAULT_TITLE = "新对话"


class ConversationService:
    def __init__(self, db: DatabaseService):
        self._db = db

    async def ensure_migrations(self) -> None:
        """历史库字段/索引兼容。建表在 scripts/init_db.py 完成。"""
        await self._ensure_column(
            "conversation", "user_id", "ADD COLUMN user_id INT NULL AFTER id"
        )
        await self._ensure_column(
            "conversation",
            "datasource_id",
            "ADD COLUMN datasource_id INT NULL AFTER user_id",
        )
        await self._ensure_column(
            "conversation",
            "semantic_state",
            "ADD COLUMN semantic_state JSON NULL COMMENT 'Semantic Summary' AFTER title",
        )
        await self._ensure_column(
            "message", "llm_messages", "ADD COLUMN llm_messages JSON NULL AFTER blocks"
        )
        await self._ensure_index(
            "message",
            "idx_conv_time",
            "ADD INDEX idx_conv_time (conversation_id, created_at)",
        )

    async def _ensure_column(self, table: str, column: str, alter_sql: str) -> None:
        try:
            rows = await self._db.query(
                "SELECT COLUMN_NAME FROM information_schema.COLUMNS "
                "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = %s AND COLUMN_NAME = %s",
                (table, column),
            )
            if not rows:
                await self._db.execute(f"ALTER TABLE {table} {alter_sql}")
        except Exception as e:
            logger.warning(f"ensure_column {table}.{column} failed: {e}")

    async def _ensure_index(self, table: str, index: str, alter_sql: str) -> None:
        try:
            rows = await self._db.query(
                "SELECT INDEX_NAME FROM information_schema.STATISTICS "
                "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = %s AND INDEX_NAME = %s",
                (table, index),
            )
            if not rows:
                await self._db.execute(f"ALTER TABLE {table} {alter_sql}")
        except Exception as e:
            logger.warning(f"ensure_index {table}.{index} failed: {e}")

    async def find_all(self, user_id: int) -> list[dict]:
        rows = await self._db.query(
            "SELECT * FROM conversation WHERE user_id = %s ORDER BY updated_at DESC",
            (user_id,),
        )
        for r in rows:
            self._parse_json_field(r, "semantic_state")
        return rows

    async def find_one(self, conv_id: str, user_id: int) -> dict | None:
        rows = await self._db.query(
            "SELECT * FROM conversation WHERE id = %s AND user_id = %s",
            (conv_id, user_id),
        )
        if not rows:
            return None
        row = rows[0]
        self._parse_json_field(row, "semantic_state")
        return row

    async def create(self, user_id: int, title: str | None = None) -> dict:
        conv_id = str(uuid.uuid4())
        safe_title = title or DEFAULT_TITLE
        await self._db.execute(
            "INSERT INTO conversation (id, user_id, title) VALUES (%s, %s, %s)",
            (conv_id, user_id, safe_title),
        )
        conv = await self.find_one(conv_id, user_id)
        if conv is None:
            raise HTTPException(status_code=500, detail="创建对话失败")
        return conv

    async def update_title(
        self, conv_id: str, title: str, datasource_id: int | None = None
    ) -> None:
        await self._db.execute(
            "UPDATE conversation SET title = %s, datasource_id = %s WHERE id = %s",
            (title, datasource_id, conv_id),
        )

    async def update_semantic_state(self, conv_id: str, state: dict) -> None:
        await self._db.execute(
            "UPDATE conversation SET semantic_state = %s WHERE id = %s",
            (json.dumps(state, ensure_ascii=False), conv_id),
        )

    async def remove(self, conv_id: str, user_id: int) -> None:
        conv = await self.find_one(conv_id, user_id)
        if not conv:
            raise HTTPException(status_code=404, detail="对话不存在或无权删除")
        # message_block -> message -> conversation 三级 ON DELETE CASCADE 自动清理
        await self._db.execute("DELETE FROM conversation WHERE id = %s", (conv_id,))

    async def get_messages(self, conv_id: str, user_id: int) -> list[dict]:
        conv = await self.find_one(conv_id, user_id)
        if not conv:
            return []

        rows = await self._db.query(
            "SELECT * FROM message WHERE conversation_id = %s ORDER BY created_at ASC",
            (conv_id,),
        )
        if not rows:
            return []

        msg_ids = [r["id"] for r in rows]
        placeholders = ", ".join(["%s"] * len(msg_ids))
        block_rows = await self._db.query(
            f"SELECT * FROM message_block WHERE message_id IN ({placeholders}) "
            f"ORDER BY message_id, sort_order",
            tuple(msg_ids),
        )

        blocks_by_msg: dict[str, list[dict]] = {}
        for b in block_rows:
            metadata = b.get("metadata")
            if isinstance(metadata, str):
                try:
                    metadata = json.loads(metadata)
                except Exception:
                    metadata = {}
            if not isinstance(metadata, dict):
                metadata = {}

            block_obj: dict[str, Any] = {"type": b["type"]}
            if b.get("content") is not None:
                block_obj["content"] = b["content"]
            block_obj.update(metadata)

            blocks_by_msg.setdefault(b["message_id"], []).append(block_obj)

        result = []
        for row in rows:
            # 优先读 message_block 行；空则回退读 message.blocks JSON 列（历史兼容）
            table_blocks = blocks_by_msg.get(row["id"])
            if table_blocks:
                blocks = table_blocks
            else:
                raw = row.get("blocks")
                if isinstance(raw, str):
                    try:
                        blocks = json.loads(raw)
                    except Exception:
                        blocks = []
                elif isinstance(raw, list):
                    blocks = raw
                else:
                    blocks = []

            llm_msgs = row.get("llm_messages")
            if isinstance(llm_msgs, str):
                try:
                    llm_msgs = json.loads(llm_msgs)
                except Exception:
                    llm_msgs = []
            elif not isinstance(llm_msgs, list):
                llm_msgs = []

            result.append(
                {
                    "id": row["id"],
                    "conversation_id": row["conversation_id"],
                    "role": row["role"],
                    "content": row.get("content") or "",
                    "blocks": blocks,
                    "llm_messages": llm_msgs,
                    "created_at": str(row["created_at"]),
                }
            )
        return result

    async def add_message(
        self,
        conv_id: str,
        role: str,
        content: str,
        blocks: list[dict],
        llm_messages: list | None = None,
    ) -> dict:
        msg_id = str(uuid.uuid4())
        llm_messages = llm_messages or []

        await self._db.execute(
            "INSERT INTO message (id, conversation_id, role, content, llm_messages) "
            "VALUES (%s, %s, %s, %s, %s)",
            (
                msg_id,
                conv_id,
                role,
                content,
                json.dumps(llm_messages, ensure_ascii=False),
            ),
        )

        if blocks:
            values: list = []
            placeholders: list[str] = []
            for i, block in enumerate(blocks):
                block_id = str(uuid.uuid4())
                b_type = block.get("type")
                b_content = block.get("content")
                # metadata = 除 type/content 外的所有字段（对齐 Nest rest 拆分）
                rest = {k: v for k, v in block.items() if k not in ("type", "content")}
                metadata_str = (
                    json.dumps(rest, ensure_ascii=False) if rest else None
                )
                values.extend([block_id, msg_id, i, b_type, b_content, metadata_str])
                placeholders.append("(%s, %s, %s, %s, %s, %s)")

            sql = (
                "INSERT INTO message_block (id, message_id, sort_order, type, content, metadata) "
                f"VALUES {', '.join(placeholders)}"
            )
            await self._db.execute(sql, tuple(values))

        await self._db.execute(
            "UPDATE conversation SET updated_at = NOW() WHERE id = %s", (conv_id,)
        )

        from datetime import datetime, timezone

        return {
            "id": msg_id,
            "conversation_id": conv_id,
            "role": role,
            "content": content,
            "blocks": blocks,
            "llm_messages": llm_messages,
            "created_at": datetime.now(timezone.utc).isoformat(),
        }

    @staticmethod
    def _parse_json_field(row: dict, field: str) -> None:
        val = row.get(field)
        if isinstance(val, str):
            try:
                row[field] = json.loads(val)
            except Exception:
                row[field] = None
        elif val is None:
            row[field] = None
