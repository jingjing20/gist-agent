from pathlib import Path
from pydantic_settings import BaseSettings

ENV_PATH = Path(__file__).resolve().parent.parent.parent / ".env"


class Settings(BaseSettings):
    DB_HOST: str = "localhost"
    DB_PORT: int = 3306
    DB_USER: str = "root"
    DB_PASSWORD: str = ""
    DB_NAME: str = "ai_analysis"

    JWT_SECRET: str = "default-secret"
    JWT_EXPIRE_DAYS: int = 7

    OPENAI_API_KEY: str = ""
    OPENAI_BASE_URL: str = "https://api.openai.com/v1"
    OPENAI_MODEL: str = "gpt-4o"

    MAX_CONTEXT_TOKENS: int = 32000

    SMTP_HOST: str = ""
    SMTP_PORT: int = 465
    SMTP_SECURE: str = "true"
    SMTP_USER: str = ""
    SMTP_PASS: str = ""
    SMTP_FROM: str = ""

    model_config = {"env_file": str(ENV_PATH), "extra": "ignore"}


settings = Settings()
