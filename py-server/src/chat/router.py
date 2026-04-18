import asyncio
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from auth.router import get_current_user
from auth.schemas import User
from chat.agents.semantic_distiller import SemanticDistillerService
from chat.agents.sql_executor import SqlExecutorAgent
from chat.prompt_builder import PromptBuilder
from chat.service import ChatService
from chat.stream_emitter import StreamEmitter
from chat.tools.analyze_result import AnalyzeResultTool
from chat.tools.generate_chart import GenerateChartTool
from chat.tools.registry import ToolRegistry
from chat.tools.sql_query import SqlQueryTool
from conversation.router import get_conversation_service
from conversation.service import ConversationService
from database.schema import SchemaService
from database.service import DatabaseService
from datasource.router import get_datasource_service, get_llm_service
from datasource.service import DataSourceService
from dependencies import get_db_service, get_schema_service
from llm.service import LlmService

router = APIRouter(prefix="/chat", tags=["chat"])


class ChatRequest(BaseModel):
    message: str
    conversationId: str
    datasourceId: int | None = None


async def get_prompt_builder(
    schema_service: Annotated[SchemaService, Depends(get_schema_service)],
    conv_service: Annotated[ConversationService, Depends(get_conversation_service)],
) -> PromptBuilder:
    return PromptBuilder(schema_service, conv_service)


async def get_sql_executor(
    db: Annotated[DatabaseService, Depends(get_db_service)],
    llm: Annotated[LlmService, Depends(get_llm_service)],
    schema_service: Annotated[SchemaService, Depends(get_schema_service)],
) -> SqlExecutorAgent:
    return SqlExecutorAgent(db, llm, schema_service)


async def get_tool_registry(
    sql_executor: Annotated[SqlExecutorAgent, Depends(get_sql_executor)],
) -> ToolRegistry:
    return ToolRegistry(
        [
            SqlQueryTool(sql_executor),
            AnalyzeResultTool(),
            GenerateChartTool(),
        ]
    )


async def get_semantic_distiller(
    llm: Annotated[LlmService, Depends(get_llm_service)],
    conv_service: Annotated[ConversationService, Depends(get_conversation_service)],
) -> SemanticDistillerService:
    return SemanticDistillerService(llm, conv_service)


async def get_chat_service(
    conv_service: Annotated[ConversationService, Depends(get_conversation_service)],
    ds_service: Annotated[DataSourceService, Depends(get_datasource_service)],
    llm: Annotated[LlmService, Depends(get_llm_service)],
    tool_registry: Annotated[ToolRegistry, Depends(get_tool_registry)],
    prompt_builder: Annotated[PromptBuilder, Depends(get_prompt_builder)],
    distiller: Annotated[SemanticDistillerService, Depends(get_semantic_distiller)],
) -> ChatService:
    return ChatService(
        conv_service, ds_service, llm, tool_registry, prompt_builder, distiller
    )


@router.post("")
async def chat(
    body: ChatRequest,
    user: Annotated[User, Depends(get_current_user)],
    chat_service: Annotated[ChatService, Depends(get_chat_service)],
):
    if not body.message or not body.message.strip():
        raise HTTPException(status_code=400, detail="消息不能为空")
    if not body.conversationId or not body.conversationId.strip():
        raise HTTPException(status_code=400, detail="conversationId 不能为空")

    emitter = StreamEmitter()

    # handle_chat 负责完整生命周期：权限检查 -> 消息入库 -> agent loop ->
    # 结果持久化 -> 异步蒸馏；后台 task 跑，主协程立刻返回流响应
    asyncio.create_task(
        chat_service.handle_chat(
            emitter,
            user.id,
            body.message,
            body.conversationId,
            body.datasourceId,
        )
    )

    return StreamingResponse(
        emitter.stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
