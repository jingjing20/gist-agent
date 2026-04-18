import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from conversation.service import ConversationService
from database.schema import SchemaService
from database.service import DatabaseService

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    pool = await DatabaseService.create_pool()
    app.state.pool = pool

    db_service = DatabaseService(pool)
    # SchemaService 必须是单例，进程级缓存才生效
    app.state.schema_service = SchemaService(db_service)

    conv_service = ConversationService(db_service)
    await conv_service.ensure_migrations()

    logger.info("Database pool initialized and migrations applied.")
    yield

    pool.close()
    await pool.wait_closed()
    logger.info("Database pool closed.")


def create_app() -> FastAPI:
    app = FastAPI(root_path="/api", lifespan=lifespan)

    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.get("/health")
    async def health():
        return {"status": "ok"}

    from auth.router import router as auth_router
    from chat.router import router as chat_router
    from conversation.router import router as conversation_router
    from datasource.router import router as datasource_router
    from user.router import router as user_router

    app.include_router(auth_router)
    app.include_router(user_router)
    app.include_router(datasource_router)
    app.include_router(conversation_router)
    app.include_router(chat_router)

    return app
