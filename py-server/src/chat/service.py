"""对话核心服务：编排 LLM 思考流程、管理上下文、触发工具执行并实时推送结果。"""

import asyncio
import json
import logging
import os
from typing import Any

from fastapi import HTTPException

from chat.agents.semantic_distiller import SemanticDistillerService
from chat.prompt_builder import PromptBuilder
from chat.stream_emitter import StreamEmitter
from chat.tools.base import ToolContext
from chat.tools.registry import ToolRegistry
from conversation.service import ConversationService
from datasource.service import DataSourceService
from llm.service import LlmService

logger = logging.getLogger(__name__)

# Agent 循环上限：防止 LLM 陷入无限 tool_call 循环（反复查错 SQL 又反复修）
MAX_AGENT_ITERATIONS = 15
# 全局超时熔断：无论 Agent 处于哪阶段，超过即强制终止
CHAT_TIMEOUT_SECONDS = 120
# 排查厂商流式 tool_call 协议差异时打开（DEBUG_TOOL_CALL_DELTA=1），生产环境关闭
DEBUG_TOOL_CALL_DELTA = os.getenv("DEBUG_TOOL_CALL_DELTA") == "1"


class ChatService:
    def __init__(
        self,
        conversation_service: ConversationService,
        datasource_service: DataSourceService,
        llm: LlmService,
        tool_registry: ToolRegistry,
        prompt_builder: PromptBuilder,
        distiller: SemanticDistillerService,
    ):
        self._conv = conversation_service
        self._ds = datasource_service
        self._llm = llm
        self._tools = tool_registry
        self._prompt = prompt_builder
        self._distiller = distiller

    async def handle_chat(
        self,
        emitter: StreamEmitter,
        user_id: int,
        message: str,
        conversation_id: str,
        datasource_id: int | None = None,
    ) -> None:
        conv = await self._conv.find_one(conversation_id, user_id)
        if not conv:
            raise HTTPException(status_code=403, detail="对话不存在或无权访问")

        if datasource_id and not await self._ds.can_access(datasource_id, user_id):
            raise HTTPException(status_code=403, detail="无权访问所选数据源")

        await self._conv.add_message(conversation_id, "user", message, [])

        if conv.get("title") == "新对话":
            title = message[:30] + ("..." if len(message) > 30 else "")
            await self._conv.update_title(conversation_id, title, datasource_id)

        system_prompt = await self._prompt.build_system_prompt(
            datasource_id, user_id, conversation_id
        )
        messages = await self._prompt.build_messages(
            conversation_id, user_id, system_prompt
        )

        blocks: list[dict] = []
        turn_messages: list[dict] = []

        try:
            await asyncio.wait_for(
                self._run_agent_loop(
                    emitter,
                    messages,
                    turn_messages,
                    blocks,
                    datasource_id,
                    user_id,
                ),
                timeout=CHAT_TIMEOUT_SECONDS,
            )
            emitter.done()
        except asyncio.TimeoutError:
            err_event = {"type": "error", "content": "分析超时，请尝试简化问题后重试"}
            emitter.send(err_event)
            blocks.append(err_event)
            emitter.end()
        except Exception as e:
            logger.error(
                "handleChat failed conversationId=%s userId=%s: %s",
                conversation_id,
                user_id,
                e,
                exc_info=True,
            )
            err_event = {"type": "error", "content": str(e)}
            emitter.send(err_event)
            blocks.append(err_event)
            emitter.end()

        # 即使失败也持久化 assistant 消息：blocks 给前端回放，turnMessages 重建 LLM 上下文
        await self._conv.add_message(
            conversation_id, "assistant", "", blocks, turn_messages
        )

        # Fire-and-forget：蒸馏失败不影响本次响应
        self._distiller.update_state_async(conversation_id, user_id, message)

    async def _run_agent_loop(
        self,
        emitter: StreamEmitter,
        messages: list[dict],
        turn_messages: list[dict],
        blocks: list[dict],
        datasource_id: int | None,
        user_id: int,
    ) -> None:
        tools_spec = self._tools.get_definitions()

        for _ in range(MAX_AGENT_ITERATIONS):
            stream = await self._llm.client.chat.completions.create(
                model=self._llm.model,
                messages=messages,
                tools=tools_spec,
                stream=True,
            )

            content = ""
            reasoning_content = ""
            tool_calls: dict[int, dict[str, Any]] = {}

            async for chunk in stream:
                if not chunk.choices:
                    continue
                delta = chunk.choices[0].delta
                if not delta:
                    continue

                rc = getattr(delta, "reasoning_content", None)
                if rc:
                    reasoning_content += rc

                if delta.content:
                    content += delta.content
                    emitter.send({"type": "text_chunk", "content": delta.content})

                if delta.tool_calls:
                    for tc in delta.tool_calls:
                        if DEBUG_TOOL_CALL_DELTA:
                            args_len = (
                                len(tc.function.arguments)
                                if tc.function and tc.function.arguments
                                else 0
                            )
                            tc_name = (
                                tc.function.name if tc.function and tc.function.name else "undef"
                            )
                            logger.info(
                                f"[tool_call delta] idx={tc.index} id={tc.id or 'undef'} "
                                f"name={tc_name} args+={args_len}"
                            )
                        idx = tc.index
                        if idx not in tool_calls:
                            name = (tc.function.name if tc.function else "") or ""
                            tool_calls[idx] = {
                                "id": tc.id,
                                "type": "function",
                                "function": {"name": name, "arguments": ""},
                            }

                            title = (
                                "[SQL 生成]"
                                if name == "execute_sql_query"
                                else f"[工具调用] {name}"
                            )
                            log_content = (
                                "正在构思查询逻辑..."
                                if name == "execute_sql_query"
                                else "正在处理..."
                            )
                            call_log = {
                                "type": "log",
                                "title": title,
                                "content": log_content,
                            }
                            emitter.send(call_log)
                            blocks.append(call_log)

                        if tc.function and tc.function.arguments:
                            tool_calls[idx]["function"]["arguments"] += (
                                tc.function.arguments
                            )

            if content:
                # 同一轮相邻多次 text 合并，避免回放碎片化
                last_block = blocks[-1] if blocks else None
                if last_block and last_block.get("type") == "text":
                    last_block["content"] = (
                        str(last_block.get("content", "")) + content
                    )
                else:
                    blocks.append({"type": "text", "content": content})

            valid_calls = [tool_calls[i] for i in sorted(tool_calls.keys())]

            if not valid_calls:
                if content:
                    msg: dict[str, Any] = {"role": "assistant", "content": content}
                    if reasoning_content:
                        msg["reasoning_content"] = reasoning_content
                    messages.append(msg)
                    turn_messages.append(msg)
                break

            assistant_msg: dict[str, Any] = {
                "role": "assistant",
                "tool_calls": valid_calls,
            }
            if content:
                assistant_msg["content"] = content
            if reasoning_content:
                assistant_msg["reasoning_content"] = reasoning_content
            messages.append(assistant_msg)
            turn_messages.append(assistant_msg)

            for tc in valid_calls:
                name = tc["function"]["name"]
                args_str = tc["function"]["arguments"]
                try:
                    args = json.loads(args_str) if args_str else {}
                except Exception:
                    args = {}

                title = (
                    "[SQL 生成]"
                    if name == "execute_sql_query"
                    else f"[工具调用] {name}"
                )
                new_content = (
                    "SQL 生成完毕，具体查询逻辑请查看下方SQL代码块"
                    if name == "execute_sql_query"
                    else (args_str or "处理完毕")
                )
                for b in reversed(blocks):
                    if b.get("type") == "log" and b.get("title") == title:
                        b["content"] = new_content
                        emitter.send({**b, "type": "log_update"})
                        break

                if name == "execute_sql_query" and args.get("sql"):
                    sql_block = {"type": "sql", "content": args["sql"]}
                    emitter.send(sql_block)
                    blocks.append(sql_block)

                tool = self._tools.get(name)
                if tool:
                    ctx = ToolContext(
                        emitter=emitter,
                        datasource_id=datasource_id,
                        user_id=user_id,
                    )
                    result = await tool.execute(args, ctx)
                    tool_result = result.tool_result
                    blocks.extend(result.blocks)
                else:
                    tool_result = f"工具 {name} 不存在"

                tool_msg = {
                    "role": "tool",
                    "tool_call_id": tc["id"],
                    "content": tool_result,
                }
                messages.append(tool_msg)
                turn_messages.append(tool_msg)
