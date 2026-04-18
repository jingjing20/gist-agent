from pydantic import BaseModel, EmailStr


class User(BaseModel):
    id: int
    email: EmailStr
    name: str
    created_at: str


class RegisterRequest(BaseModel):
    email: EmailStr
    password: str
    name: str | None = None


class LoginRequest(BaseModel):
    email: EmailStr
    password: str


class ForgotPasswordRequest(BaseModel):
    email: EmailStr
    origin: str | None = None


class ResetPasswordRequest(BaseModel):
    token: str
    password: str


class AuthResponse(BaseModel):
    user: User
    token: str
