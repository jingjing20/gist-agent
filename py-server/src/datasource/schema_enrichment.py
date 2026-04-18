import asyncio
import json
import logging
import re

from database.service import DatabaseService
from llm.service import LlmService

logger = logging.getLogger(__name__)


class SchemaEnrichmentService:
    """异步给刚上传的表做字段语义增强，用 LLM 根据 样本+原注释 推导更丰富的 COMMENT。"""

    def __init__(self, db: DatabaseService, llm: LlmService):
        self._db = db
        self._llm = llm

    def enrich_table_schema_async(self, table_name: str) -> None:
        """Fire-and-forget；失败只记日志不影响主流程。"""

        async def _run():
            try:
                await self._enrich_table_schema(table_name)
            except Exception as e:
                logger.error(f"Async enrichment failed for {table_name}: {e}")

        try:
            asyncio.get_running_loop().create_task(_run())
        except RuntimeError:
            logger.warning(
                f"No running loop; skip async enrichment for {table_name}"
            )

    async def _enrich_table_schema(self, table_name: str) -> None:
        cols = await self._db.query(
            """
            SELECT COLUMN_NAME, COLUMN_TYPE, COLUMN_COMMENT
            FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = %s
            ORDER BY ORDINAL_POSITION
            """,
            (table_name,),
        )
        if not cols:
            return

        samples = await self._db.query(f"SELECT * FROM `{table_name}` LIMIT 5")
        if not samples:
            return

        system_prompt = (
            "你是一个资深的数据架构师。你的任务是根据给定的表结构和真实数据样本，推导并增强各个字段的业务注释。\n"
            "要求：\n"
            "- 注意推导分类字段的可能取值、时间字段的格式、数字字段的可能业务含义（例如金额单位、数量等）。\n"
            "- 结合原有注释、字段名和数据样例，给出一个精炼且带更多语义信息的注释（适合未来给大模型生成 SQL 时参考阅读）。\n"
            '- 只返回严格的 JSON 数组，格式必须为 [{"column": "原字段名", "comment": "丰富增强后的注释(如果原注释好则保留+补充)"}]。\n'
            "- 没有解释，只有 JSON。"
        )

        col_lines = "\n".join(
            f"- {c['COLUMN_NAME']} ({c['COLUMN_TYPE']}): {c.get('COLUMN_COMMENT') or ''}"
            for c in cols
        )
        user_prompt = (
            f"表（{table_name}）结构：\n{col_lines}\n\n"
            f"前 5 条真实数据样本：\n{json.dumps(samples, ensure_ascii=False, default=str, indent=2)}"
        )

        response = await self._llm.chat(system_prompt, user_prompt, temperature=0)
        match = re.search(r"\[[\s\S]*\]", response)
        if not match:
            raise RuntimeError("LLM did not return a JSON array")

        enrichments = json.loads(match.group(0))

        col_by_name = {c["COLUMN_NAME"]: c for c in cols}
        for e in enrichments:
            col = col_by_name.get(e.get("column"))
            if not col:
                continue
            new_comment = str(e.get("comment", ""))[:1000]
            await self._db.execute(
                f"ALTER TABLE `{table_name}` MODIFY `{col['COLUMN_NAME']}` "
                f"{col['COLUMN_TYPE']} COMMENT %s",
                (new_comment,),
            )

        logger.info(
            f"Table [{table_name}] schema enrichment completed successfully."
        )
