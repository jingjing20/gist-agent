from typing import Annotated

from fastapi import APIRouter, Depends

from auth.router import get_current_user
from auth.schemas import User
from database.service import DatabaseService
from dependencies import get_db_service
from user.schemas import PasswordUpdateRequest, ProfileUpdateRequest, UserSearchItem
from user.service import UserService

router = APIRouter(prefix="/users", tags=["users"])


async def get_user_service(
    db: Annotated[DatabaseService, Depends(get_db_service)],
) -> UserService:
    return UserService(db)


@router.get("/search", response_model=list[UserSearchItem])
async def search(
    q: str,
    _user: Annotated[User, Depends(get_current_user)],
    user_service: Annotated[UserService, Depends(get_user_service)],
):
    return await user_service.search_by_email(q)


@router.put("/profile")
async def update_profile(
    body: ProfileUpdateRequest,
    user: Annotated[User, Depends(get_current_user)],
    user_service: Annotated[UserService, Depends(get_user_service)],
):
    await user_service.update_profile(user.id, body.name)
    return {"success": True}


@router.put("/password")
async def update_password(
    body: PasswordUpdateRequest,
    user: Annotated[User, Depends(get_current_user)],
    user_service: Annotated[UserService, Depends(get_user_service)],
):
    await user_service.update_password(user.id, body.password)
    return {"success": True}
