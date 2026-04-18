"""语义蒸馏器：从对话中提取业务口径定义，持久化到 conversation.semantic_state。

三级压缩记忆会丢远距细节，但用户自定义口径（"活跃 = 登录且消费"）必须跨轮保留，
每轮对话结束后异步蒸馏，写回 DB，下轮 System Prompt 注入实现长期记忆。
"""

import asyncio
import json
import logging
import re

from conversation.service import ConversationService
from llm.service import LlmService

logger = logging.getLogger(__name__)


class SemanticDistillerService:
    def __init__(self, llm: LlmService, conversation: ConversationService):
        self._llm = llm
        self._conversation = conversation

    def update_state_async(
        self, conversation_id: str, user_id: int, user_message: str
    ) -> None:
        async def _run():
            try:
                await self._distill_and_update(
                    conversation_id, user_id, user_message
                )
            except Exception as e:
                logger.warning(
                    f"Semantic Distillation failed for conv {conversation_id}: {e}"
                )

        try:
            asyncio.get_running_loop().create_task(_run())
        except RuntimeError:
            pass

    async def _distill_and_update(
        self, conversation_id: str, user_id: int, user_message: str
    ) -> None:
        conv = await self._conversation.find_one(conversation_id, user_id)
        if not conv:
            return

        raw_state = conv.get("semantic_state")
        if isinstance(raw_state, str):
            try:
                raw_state = json.loads(raw_state)
            except Exception:
                raw_state = None
        if not isinstance(raw_state, dict):
            raw_state = {}
        current_state = {"definitions": raw_state.get("definitions") or {}}

        system_prompt = (
            "你是一个幕后的知识蒸馏 Agent。你的任务是从数据分析对话中提取【业务名词口径】。\n"
            "规则：\n"
            "1. 若用户在对话中定义了业务口径（如\"活跃就是登录且消费\"），提取加入 definitions。\n"
            "2. 只提取用户主观定义的口径，不要提取查询结果中的数据事实。\n"
            "3. 返回必须是合法的 JSON 对象，包含 \"definitions\" 字典（值必是字符串）。"
            "不要任何多余的话语或Markdown代码块。格式如：{\"definitions\":{}}。\n"
            "4. 若无新口径，直接原样返回旧的状态。"
        )
        user_prompt = (
            f"旧的状态: {json.dumps(current_state, ensure_ascii=False)}\n"
            f"新的一轮对话：\n用户问: {user_message}\n\n"
            "请基于新回合信息，决定是否更新旧的状态，并返回更新后的完整纯 JSON 参数。"
        )

        response = await self._llm.chat(system_prompt, user_prompt, temperature=0.1)
        match = re.search(r"\{[\s\S]*\}", response)
        if not match:
            return

        try:
            new_state = json.loads(match.group(0))
            await self._conversation.update_semantic_state(conversation_id, new_state)
            logger.info(f"Semantic state updated for conv {conversation_id}")
        except Exception as e:
            logger.error(f"Failed to parse/update distilled state: {e}")
