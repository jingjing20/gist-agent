from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from typing import Any, AsyncIterator, Sequence

import aiomysql

from config import settings

logger = logging.getLogger(__name__)


class DatabaseService:
    def __init__(self, pool: aiomysql.Pool) -> None:
        self._pool = pool

    @staticmethod
    async def create_pool() -> aiomysql.Pool:
        return await aiomysql.create_pool(
            host=settings.DB_HOST,
            port=settings.DB_PORT,
            user=settings.DB_USER,
            password=settings.DB_PASSWORD,
            db=settings.DB_NAME,
            autocommit=True,
            minsize=1,
            maxsize=10,
            charset="utf8mb4",
            local_infile=True,
        )

    async def query(
        self,
        sql: str,
        params: Sequence[Any] | None = None,
    ) -> list[dict[str, Any]]:
        async with self._pool.acquire() as conn:
            async with conn.cursor(aiomysql.DictCursor) as cur:
                await cur.execute(sql, params or ())
                return await cur.fetchall()

    async def execute(
        self,
        sql: str,
        params: Sequence[Any] | None = None,
    ) -> int:
        """Execute a write statement. Returns lastrowid for INSERT, affected rows for UPDATE/DELETE."""
        async with self._pool.acquire() as conn:
            async with conn.cursor() as cur:
                await cur.execute(sql, params or ())
                return cur.lastrowid

    @asynccontextmanager
    async def transaction(self) -> AsyncIterator[_TransactionConnection]:
        conn = await self._pool.acquire()
        await conn.begin()
        try:
            yield _TransactionConnection(conn)
            await conn.commit()
        except Exception:
            await conn.rollback()
            raise
        finally:
            self._pool.release(conn)

    async def close(self) -> None:
        self._pool.close()
        await self._pool.wait_closed()


class _TransactionConnection:
    """Thin wrapper exposing query/execute on a transactional connection."""

    def __init__(self, conn: aiomysql.Connection) -> None:
        self._conn = conn

    async def query(
        self, sql: str, params: Sequence[Any] | None = None
    ) -> list[dict[str, Any]]:
        async with self._conn.cursor(aiomysql.DictCursor) as cur:
            await cur.execute(sql, params or ())
            return await cur.fetchall()

    async def execute(
        self, sql: str, params: Sequence[Any] | None = None
    ) -> int:
        async with self._conn.cursor() as cur:
            await cur.execute(sql, params or ())
            return cur.lastrowid
