import asyncio
import json
import logging
import re

from database.schema import SchemaService
from database.service import DatabaseService
from llm.service import LlmService

logger = logging.getLogger(__name__)


class SuggestionService:
    def __init__(
        self, db: DatabaseService, schema: SchemaService, llm: LlmService
    ):
        self._db = db
        self._schema = schema
        self._llm = llm

    async def get_suggestions(
        self, datasource_id: int, user_id: int
    ) -> list[str]:
        cached = await self._get_from_cache(datasource_id, user_id)
        if cached:
            return cached
        return await self._generate_and_cache(datasource_id, user_id)

    def trigger_async(self, datasource_id: int, user_id: int) -> None:
        async def _run():
            try:
                await self._generate_and_cache(datasource_id, user_id)
            except Exception as e:
                logger.warning(
                    f"Suggestion triggerAsync failed for ds={datasource_id}: {e}"
                )

        try:
            asyncio.get_running_loop().create_task(_run())
        except RuntimeError:
            pass

    def invalidate_and_regenerate(
        self, datasource_id: int, user_id: int
    ) -> None:
        async def _run():
            try:
                await self._db.execute(
                    "DELETE FROM datasource_suggestions "
                    "WHERE datasource_id = %s AND user_id = %s",
                    (datasource_id, user_id),
                )
            except Exception:
                pass
            self.trigger_async(datasource_id, user_id)

        try:
            asyncio.get_running_loop().create_task(_run())
        except RuntimeError:
            pass

    async def _get_from_cache(
        self, datasource_id: int, user_id: int
    ) -> list[str] | None:
        rows = await self._db.query(
            "SELECT questions FROM datasource_suggestions "
            "WHERE datasource_id = %s AND user_id = %s",
            (datasource_id, user_id),
        )
        if not rows:
            return None
        q = rows[0]["questions"]
        if isinstance(q, str):
            try:
                return json.loads(q)
            except Exception:
                return None
        return q

    async def _generate_and_cache(
        self, datasource_id: int, user_id: int
    ) -> list[str]:
        schema_prompt = await self._schema.get_database_schema_prompt(
            datasource_id, user_id
        )
        questions = await self._call_llm(schema_prompt)
        await self._db.execute(
            """
            INSERT INTO datasource_suggestions (datasource_id, user_id, questions)
            VALUES (%s, %s, %s)
            ON DUPLICATE KEY UPDATE questions = VALUES(questions),
                                    created_at = CURRENT_TIMESTAMP
            """,
            (datasource_id, user_id, json.dumps(questions, ensure_ascii=False)),
        )
        return questions

    async def _call_llm(self, schema_prompt: str) -> list[str]:
        system = (
            "你是一个业务数据分析专家。根据给定的数据库 schema，生成 3 个业务人员最关心的、"
            "可以用自然语言提问的问题。\n"
            "要求：\n"
            "- 使用简洁、自然的业务口吻提问（例如：“帮我分析下不同平台的活跃趋势”）\n"
            "- **禁止** 在问题中提及具体的表名、字段名或任何数据库术语（如：关联、主键、指标计算等）\n"
            "- 问题要聚焦核心业务价值（如：留存分析、各区域对比、增长趋势等）\n"
            '- 只返回 JSON 数组，格式：["问题1", "问题2", "问题3"]\n'
            "- 不要有任何辅助文字"
        )
        user = f"数据库 Schema:\n{schema_prompt}"
        raw = await self._llm.chat(system, user, temperature=0.3)
        match = re.search(r"\[[\s\S]*\]", raw)
        if not match:
            raise RuntimeError("LLM returned invalid JSON for suggestions")
        parsed = json.loads(match.group(0))
        if not isinstance(parsed, list) or len(parsed) < 1:
            raise RuntimeError("LLM returned invalid array")
        return parsed[:3]
