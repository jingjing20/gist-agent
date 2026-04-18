from fastapi import Request

from database.schema import SchemaService
from database.service import DatabaseService


async def get_db_service(request: Request) -> DatabaseService:
    return DatabaseService(request.app.state.pool)


async def get_schema_service(request: Request) -> SchemaService:
    """Global SchemaService singleton（与 Nest 的 @Global() DatabaseModule 对齐，
    保留进程内 1 分钟 schema prompt 缓存的效用）"""
    return request.app.state.schema_service
