from pydantic import BaseModel


class DataSourceCreate(BaseModel):
    name: str
    description: str | None = None


class DataSourceUpdate(BaseModel):
    name: str | None = None
    description: str | None = None


class GrantRevokeRequest(BaseModel):
    userId: int
