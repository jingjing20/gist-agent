from pydantic import BaseModel


class ProfileUpdateRequest(BaseModel):
    name: str


class PasswordUpdateRequest(BaseModel):
    password: str


class UserSearchItem(BaseModel):
    id: int
    email: str
    name: str
