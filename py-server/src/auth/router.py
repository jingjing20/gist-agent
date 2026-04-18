import logging
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
from jose import JWTError, jwt

from config import settings
from database.service import DatabaseService
from auth.mailer import MailerService
from auth.schemas import (
    AuthResponse,
    ForgotPasswordRequest,
    LoginRequest,
    RegisterRequest,
    ResetPasswordRequest,
    User,
)
from auth.service import AuthService
# Ensure this imports properly once we define the dependency in dependencies.py
from dependencies import get_db_service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/auth", tags=["auth"])
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="auth/login")


async def get_mailer_service() -> MailerService:
    return MailerService()


async def get_auth_service(
    db: Annotated[DatabaseService, Depends(get_db_service)],
    mailer: Annotated[MailerService, Depends(get_mailer_service)],
) -> AuthService:
    return AuthService(db=db, mailer=mailer)


async def get_current_user(
    token: Annotated[str, Depends(oauth2_scheme)],
    auth_service: Annotated[AuthService, Depends(get_auth_service)],
) -> User:
    """Dependency that verifies JWT token and retrieves the current user."""
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Could not validate credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )
    try:
        payload = jwt.decode(token, settings.JWT_SECRET, algorithms=["HS256"])
        user_id_str: str | None = payload.get("sub")
        if user_id_str is None:
            raise credentials_exception
        user_id = int(user_id_str)
    except (JWTError, ValueError):
        raise credentials_exception

    try:
        user = await auth_service.find_by_id(user_id)
    except HTTPException:
        raise credentials_exception
        
    return user


@router.post("/register", response_model=AuthResponse)
async def register(
    body: RegisterRequest, auth_service: Annotated[AuthService, Depends(get_auth_service)]
):
    if not body.email.strip() or not body.password.strip():
        raise HTTPException(status_code=400, detail="邮箱和密码不能为空")
    if len(body.password) < 6:
        raise HTTPException(status_code=400, detail="密码至少 6 位")
    return await auth_service.register(body.email, body.password, body.name)


@router.post("/login", response_model=AuthResponse)
async def login(
    body: LoginRequest, auth_service: Annotated[AuthService, Depends(get_auth_service)]
):
    if not body.email.strip() or not body.password.strip():
        raise HTTPException(status_code=400, detail="邮箱和密码不能为空")
    return await auth_service.login(body.email, body.password)


@router.post("/forgot-password")
async def forgot_password(
    body: ForgotPasswordRequest, auth_service: Annotated[AuthService, Depends(get_auth_service)]
):
    if not body.email.strip():
        raise HTTPException(status_code=400, detail="邮箱不能为空")
    try:
        await auth_service.request_reset(body.email, body.origin)
    except ValueError as e:
        # SMTP not configured
        raise HTTPException(status_code=500, detail=str(e))
    return {"message": "若该邮箱已注册，重置链接已发送，请查收邮件"}


@router.post("/reset-password")
async def reset_password(
    body: ResetPasswordRequest, auth_service: Annotated[AuthService, Depends(get_auth_service)]
):
    await auth_service.reset_password(body.token, body.password)
    return {"message": "密码已重置，请重新登录"}


@router.post("/me", response_model=User)
@router.get("/me", response_model=User)  # It's common to have a GET for /me
async def get_me(user: Annotated[User, Depends(get_current_user)]):
    return user
