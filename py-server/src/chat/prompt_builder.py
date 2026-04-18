"""提示词构建器：组装 System Prompt 并按 Token 预算管理上下文窗口。

采用三级压缩 (Full/Medium/Compact) + 距离窗口策略，在有限 Context 内保留尽可能多信息。
"""

import json
import logging
import os
from dataclasses import dataclass
from datetime import datetime
from typing import Literal

from chat.token_estimator import estimate_message_tokens, estimate_messages_tokens
from conversation.service import ConversationService
from database.schema import SchemaService

logger = logging.getLogger(__name__)

# Token 预算分配
MAX_CONTEXT_TOKENS = int(os.getenv("MAX_CONTEXT_TOKENS", "32000"))
RESPONSE_RESERVE = 4000
TOOLS_RESERVE = 1500

# 距离窗口：最近 FULL_WINDOW 条保留完整 tool chain，
# FULL_WINDOW ~ MEDIUM_WINDOW 条保留 SQL+行数+结论，
# 超出的只保留文字摘要
FULL_WINDOW = 2
MEDIUM_WINDOW = 6

CompressionLevel = Literal["full", "medium", "compact"]


@dataclass
class HistoryEntry:
    full_messages: list[dict]
    medium_messages: list[dict]
    compact_messages: list[dict]
    full_tokens: int
    medium_tokens: int
    compact_tokens: int


class PromptBuilder:
    def __init__(
        self, schema_service: SchemaService, conversation_service: ConversationService
    ):
        self._schema = schema_service
        self._conv = conversation_service

    async def build_system_prompt(
        self,
        datasource_id: int | None,
        user_id: int,
        conversation_id: str | None = None,
    ) -> str:
        today = datetime.now().strftime("%Y-%m-%d")
        schema_prompt = await self._schema.get_database_schema_prompt(
            datasource_id, user_id
        )

        state_prompt = ""
        if conversation_id:
            conv = await self._conv.find_one(conversation_id, user_id)
            semantic_state = (conv or {}).get("semantic_state")
            if isinstance(semantic_state, dict):
                defs = semantic_state.get("definitions") or {}
                if defs:
                    lines = "\n".join(f"- {k}: {v}" for k, v in defs.items())
                    state_prompt = f"\n## 业务口径定义 (Semantic Memory)\n{lines}\n"

        return (
            f"你是一个名为 Gist Agent 的高级数据分析专家。当前日期：{today}\n"
            f"可用数据库表：\n{schema_prompt}\n"
            f"{state_prompt}"
            f"## 工作流程（严格按顺序执行，不可跳步）\n\n"
            f"1. **理解需求** — 分析用户问题，确定所需的表和字段。\n"
            f"2. **查询数据** — 编写 SELECT 语句，调用 execute_sql_query。\n"
            f"3. **可视化判断** — 必须调用 analyze_result 判断查询结果是否需要图表可视化。\n"
            f"4. **生成图表** — 仅当 analyze_result 中 needsChart=true 时，调用 generate_chart 提供完整数据。\n"
            f"5. **文字总结** — 最后用自然语言直接回答用户问题，给出清晰的分析结论。\n\n"
            f"## 规则\n"
            f"- 查询数据后必须先调 analyze_result，再决定是否调 generate_chart。禁止跳过 analyze_result 直接生成图表。\n"
            f"- 文字总结必须在所有工具调用完成后再输出，不要在工具调用过程中输出。\n"
            f"- generate_chart 的数据必须严格来自 execute_sql_query 的查询结果，不得编造数据。"
        )

    async def build_messages(
        self, conversation_id: str, user_id: int, system_prompt: str
    ) -> list[dict]:
        system_msg: dict = {"role": "system", "content": system_prompt}
        system_tokens = estimate_message_tokens(system_msg)
        budget = MAX_CONTEXT_TOKENS - system_tokens - RESPONSE_RESERVE - TOOLS_RESERVE

        history = await self._conv.get_messages(conversation_id, user_id)
        if not history:
            return [system_msg]

        entries = [self._to_history_entry(m) for m in history]
        selected = self._select_entries_within_budget(entries, budget)

        messages: list[dict] = [system_msg]
        for idx, level in selected:
            messages.extend(self._get_messages_for_level(entries[idx], level))

        level_mark = "".join(level[0] for _, level in selected)
        logger.debug(
            f"Context: {len(history)} msgs, {len(selected)} included ({level_mark}), "
            f"budget {budget} tokens, system {system_tokens} tokens"
        )
        return messages

    def _to_history_entry(self, msg: dict) -> HistoryEntry:
        if msg["role"] == "user":
            user_msg = {"role": "user", "content": msg.get("content", "")}
            tokens = estimate_message_tokens(user_msg)
            return HistoryEntry(
                full_messages=[user_msg],
                medium_messages=[user_msg],
                compact_messages=[user_msg],
                full_tokens=tokens,
                medium_tokens=tokens,
                compact_tokens=tokens,
            )

        compact_text = self._extract_compact_text(msg)
        compact_msg = {
            "role": "assistant",
            "content": compact_text or "(无文字回复)",
        }
        compact_tokens = estimate_message_tokens(compact_msg)

        llm_messages = msg.get("llm_messages")
        has_llm = isinstance(llm_messages, list) and len(llm_messages) > 0

        if has_llm:
            full_messages = [self._dehydrate_message(m) for m in llm_messages]
            full_tokens = estimate_messages_tokens(full_messages)
            medium_messages = self._build_medium_messages(llm_messages, compact_text)
            medium_tokens = estimate_messages_tokens(medium_messages)
        else:
            full_messages = [compact_msg]
            full_tokens = compact_tokens
            medium_messages = [compact_msg]
            medium_tokens = compact_tokens

        return HistoryEntry(
            full_messages=full_messages,
            medium_messages=medium_messages,
            compact_messages=[compact_msg],
            full_tokens=full_tokens,
            medium_tokens=medium_tokens,
            compact_tokens=compact_tokens,
        )

    def _build_medium_messages(
        self, llm_messages: list[dict], fallback_text: str
    ) -> list[dict]:
        """medium：坍缩一整轮 tool chain 为一条 assistant 文本。
        保留 SQL 文本 + 结果行数 + 最终文字结论；丢弃原始数据、图表参数、analyze_result。
        """
        parts: list[str] = []

        for msg in llm_messages:
            role = msg.get("role")
            tool_calls = msg.get("tool_calls")

            if role == "assistant" and tool_calls:
                for call in tool_calls:
                    fn = (call or {}).get("function") or {}
                    if fn.get("name") == "execute_sql_query":
                        try:
                            args = json.loads(fn.get("arguments") or "{}")
                            if args.get("sql"):
                                parts.append(f"[SQL] {args['sql']}")
                        except Exception:
                            pass

            if role == "tool" and isinstance(msg.get("content"), str):
                row_count = self._extract_row_count(msg["content"])
                if row_count is not None:
                    parts.append(f"[结果: {row_count} 行]")

            if (
                role == "assistant"
                and not tool_calls
                and isinstance(msg.get("content"), str)
                and msg["content"].strip()
            ):
                parts.append(msg["content"])

        content = "\n".join(parts) if parts else (fallback_text or "(无文字回复)")
        return [{"role": "assistant", "content": content}]

    @staticmethod
    def _extract_row_count(content: str) -> int | None:
        try:
            raw = json.loads(content)
            if isinstance(raw, list):
                return len(raw)
            if isinstance(raw, dict) and isinstance(raw.get("data"), list):
                return len(raw["data"])
        except Exception:
            pass
        return None

    def _dehydrate_message(self, msg: dict) -> dict:
        """full 级脱水：tool 结果只留元信息，generate_chart 的 data 剥离。"""
        role = msg.get("role")
        if role == "tool" and isinstance(msg.get("content"), str):
            return {**msg, "content": self._dehydrate_tool_result(msg["content"])}

        if role == "assistant" and msg.get("tool_calls"):
            calls = [self._dehydrate_tool_call(c) for c in msg["tool_calls"]]
            return {**msg, "tool_calls": calls}

        return msg

    @staticmethod
    def _dehydrate_tool_result(content: str) -> str:
        try:
            raw = json.loads(content)
            if isinstance(raw, list):
                if not raw:
                    return "[查询结果: 0 行]"
                columns = list(raw[0].keys()) if isinstance(raw[0], dict) else []
                return f"[查询结果: {len(raw)} 行, 列: {', '.join(columns)}]"

            if isinstance(raw, dict) and isinstance(raw.get("data"), list):
                total = len(raw["data"])
                columns = (
                    list(raw["data"][0].keys())
                    if total > 0 and isinstance(raw["data"][0], dict)
                    else []
                )
                meta = f"[查询结果: {total} 行, 列: {', '.join(columns)}]"
                sys_msg = raw.get("systemMessage")
                return f"{meta}\n{sys_msg}" if sys_msg else meta

            s = json.dumps(raw, ensure_ascii=False)
            return s[:500] + "...[已截断]" if len(s) > 500 else content
        except Exception:
            return content[:500] + "...[已截断]" if len(content) > 500 else content

    @staticmethod
    def _dehydrate_tool_call(call: dict) -> dict:
        fn = (call or {}).get("function") or {}
        if fn.get("name") == "generate_chart" and fn.get("arguments"):
            try:
                args = json.loads(fn["arguments"])
                skeleton = {
                    "chartType": args.get("chartType"),
                    "title": args.get("title"),
                    "xAxisName": args.get("xAxisName"),
                    "_note": "[图表数据已省略]",
                }
                return {
                    **call,
                    "function": {
                        **fn,
                        "arguments": json.dumps(skeleton, ensure_ascii=False),
                    },
                }
            except Exception:
                pass
        return call

    @staticmethod
    def _extract_compact_text(msg: dict) -> str:
        content = msg.get("content")
        if content:
            return content
        blocks = msg.get("blocks") or []
        if not isinstance(blocks, list):
            return ""
        return "\n".join(
            b.get("content", "") for b in blocks if b.get("type") == "text"
        )

    def _select_entries_within_budget(
        self, entries: list[HistoryEntry], budget: int
    ) -> list[tuple[int, CompressionLevel]]:
        """从最新往旧选历史，按距离分配压缩级别。
        最近 FULL_WINDOW 条: full -> medium -> compact
        中距 MEDIUM_WINDOW 条: medium -> compact
        远距: compact only
        放不下则跳过，不 break，继续尝试更早条目。
        """
        remaining = budget
        selected: list[tuple[int, CompressionLevel]] = []
        total = len(entries)

        for i in range(total - 1, -1, -1):
            entry = entries[i]
            distance = total - 1 - i

            if distance < FULL_WINDOW:
                levels: list[CompressionLevel] = ["full", "medium", "compact"]
            elif distance < MEDIUM_WINDOW:
                levels = ["medium", "compact"]
            else:
                levels = ["compact"]

            for level in levels:
                tokens = self._get_tokens_for_level(entry, level)
                if tokens <= remaining:
                    selected.insert(0, (i, level))
                    remaining -= tokens
                    break

        return selected

    @staticmethod
    def _get_tokens_for_level(entry: HistoryEntry, level: CompressionLevel) -> int:
        if level == "full":
            return entry.full_tokens
        if level == "medium":
            return entry.medium_tokens
        return entry.compact_tokens

    @staticmethod
    def _get_messages_for_level(
        entry: HistoryEntry, level: CompressionLevel
    ) -> list[dict]:
        if level == "full":
            return entry.full_messages
        if level == "medium":
            return entry.medium_messages
        return entry.compact_messages
