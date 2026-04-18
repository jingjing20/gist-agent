from typing import Annotated

from fastapi import APIRouter, Depends

from auth.router import get_current_user
from auth.schemas import User
from conversation.schemas import CreateConversationRequest
from conversation.service import ConversationService
from database.service import DatabaseService
from dependencies import get_db_service

router = APIRouter(prefix="/conversations", tags=["conversations"])


async def get_conversation_service(
    db: Annotated[DatabaseService, Depends(get_db_service)],
) -> ConversationService:
    return ConversationService(db)


@router.get("")
async def find_all(
    user: Annotated[User, Depends(get_current_user)],
    service: Annotated[ConversationService, Depends(get_conversation_service)],
):
    return await service.find_all(user.id)


@router.post("")
async def create(
    body: CreateConversationRequest,
    user: Annotated[User, Depends(get_current_user)],
    service: Annotated[ConversationService, Depends(get_conversation_service)],
):
    return await service.create(user.id, body.title)


@router.delete("/{id}")
async def remove(
    id: str,
    user: Annotated[User, Depends(get_current_user)],
    service: Annotated[ConversationService, Depends(get_conversation_service)],
):
    await service.remove(id, user.id)
    return {"success": True}


@router.get("/{id}/messages")
async def get_messages(
    id: str,
    user: Annotated[User, Depends(get_current_user)],
    service: Annotated[ConversationService, Depends(get_conversation_service)],
):
    return await service.get_messages(id, user.id)
