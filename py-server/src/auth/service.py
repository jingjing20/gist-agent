import secrets
from fastapi import HTTPException

from database.service import DatabaseService
from auth.mailer import MailerService
from auth.schemas import User, AuthResponse
from auth.utils import get_password_hash, verify_password, create_access_token


class AuthService:
    def __init__(self, db: DatabaseService, mailer: MailerService):
        self._db = db
        self._mailer = mailer

    async def register(self, email: str, password: str, name: str | None) -> AuthResponse:
        email = email.lower().strip()
        rows = await self._db.query("SELECT id FROM user WHERE email = %s", (email,))
        if rows:
            raise HTTPException(status_code=409, detail="该邮箱已注册")

        pw_hash = get_password_hash(password)
        name = (name or email.split("@")[0]).strip()

        user_id = await self._db.execute(
            "INSERT INTO user (email, password_hash, name) VALUES (%s, %s, %s)",
            (email, pw_hash, name),
        )

        user = await self.find_by_id(user_id)
        token = create_access_token(user_id, email)
        return AuthResponse(user=user, token=token)

    async def login(self, email: str, password: str) -> AuthResponse:
        email = email.lower().strip()
        rows = await self._db.query(
            "SELECT id, email, name, password_hash, created_at FROM user WHERE email = %s",
            (email,),
        )
        if not rows:
            raise HTTPException(status_code=401, detail="邮箱或密码错误")

        row = rows[0]
        if not verify_password(password, row["password_hash"]):
            raise HTTPException(status_code=401, detail="邮箱或密码错误")

        user = User(
            id=row["id"],
            email=row["email"],
            name=row["name"],
            created_at=str(row["created_at"]),
        )
        token = create_access_token(user.id, user.email)
        return AuthResponse(user=user, token=token)

    async def request_reset(self, email: str, origin: str | None = None) -> None:
        email = email.lower().strip()
        rows = await self._db.query("SELECT id FROM user WHERE email = %s", (email,))
        if not rows:
            return  # 故意不暴露是否存在

        user_id = rows[0]["id"]
        token = secrets.token_hex(32)

        await self._db.execute(
            "INSERT INTO password_reset_token (user_id, token, expires_at) VALUES (%s, %s, DATE_ADD(NOW(), INTERVAL 15 MINUTE))",
            (user_id, token),
        )

        base_url = (origin or "http://localhost:5173").rstrip("/")
        reset_url = f"{base_url}/#/reset-password?token={token}"
        await self._mailer.send_reset_email(email, reset_url)

    async def reset_password(self, token: str, new_password: str) -> None:
        token = token.strip()
        if not token:
            raise HTTPException(status_code=400, detail="token 不能为空")
        if not new_password or len(new_password) < 6:
            raise HTTPException(status_code=400, detail="密码至少 6 位")

        async with self._db.transaction() as conn:
            rows = await conn.query(
                "SELECT id, user_id FROM password_reset_token WHERE token = %s AND expires_at > NOW() AND used_at IS NULL",
                (token,),
            )
            if not rows:
                raise HTTPException(status_code=400, detail="链接已失效或已使用")

            token_id = rows[0]["id"]
            user_id = rows[0]["user_id"]
            pw_hash = get_password_hash(new_password)

            await conn.execute("UPDATE user SET password_hash = %s WHERE id = %s", (pw_hash, user_id))
            await conn.execute("UPDATE password_reset_token SET used_at = NOW() WHERE id = %s", (token_id,))

    async def find_by_id(self, user_id: int) -> User:
        rows = await self._db.query(
            "SELECT id, email, name, created_at FROM user WHERE id = %s",
            (user_id,),
        )
        if not rows:
            raise HTTPException(status_code=401, detail="用户不存在")
        row = rows[0]
        return User(
            id=row["id"],
            email=row["email"],
            name=row["name"],
            created_at=str(row["created_at"]),
        )
