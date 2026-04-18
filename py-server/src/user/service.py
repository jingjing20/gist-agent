from fastapi import HTTPException

from database.service import DatabaseService
from auth.utils import get_password_hash


class UserService:
    def __init__(self, db: DatabaseService):
        self._db = db

    async def search_by_email(self, q: str, limit: int = 20) -> list[dict]:
        q = (q or "").strip()
        if len(q) < 2:
            return []

        rows = await self._db.query(
            "SELECT id, email, name FROM user WHERE email LIKE %s ORDER BY email LIMIT %s",
            (f"%{q}%", limit),
        )
        return rows

    async def update_profile(self, user_id: int, name: str) -> None:
        name = (name or "").strip()
        if not name:
            raise HTTPException(status_code=400, detail="用户名不能为空")

        await self._db.execute("UPDATE user SET name = %s WHERE id = %s", (name, user_id))

    async def update_password(self, user_id: int, new_password: str) -> None:
        if not new_password or len(new_password) < 6:
            raise HTTPException(status_code=400, detail="密码至少 6 位")

        pw_hash = get_password_hash(new_password)
        await self._db.execute(
            "UPDATE user SET password_hash = %s WHERE id = %s", (pw_hash, user_id)
        )
