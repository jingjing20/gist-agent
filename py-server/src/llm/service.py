from __future__ import annotations

import logging
from typing import AsyncGenerator

from langsmith.wrappers import wrap_openai
from openai import AsyncOpenAI

from config import settings

logger = logging.getLogger(__name__)


class LlmService:
    def __init__(self) -> None:
        raw_client = AsyncOpenAI(
            api_key=settings.OPENAI_API_KEY,
            base_url=settings.OPENAI_BASE_URL,
        )
        self.client = wrap_openai(raw_client)
        self.model = settings.OPENAI_MODEL

    async def chat(self, system_prompt: str, user_prompt: str, temperature: float = 0.0) -> str:
        response = await self.client.chat.completions.create(
            model=self.model,
            temperature=temperature,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
        )

        content = response.choices[0].message.content
        if not content:
            raise ValueError("LLM returned empty response")
        return content.strip()

    async def chat_stream(
        self, system_prompt: str, user_prompt: str, temperature: float = 0.0
    ) -> AsyncGenerator[str, None]:
        response = await self.client.chat.completions.create(
            model=self.model,
            temperature=temperature,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            stream=True,
        )

        async for chunk in response:
            delta = chunk.choices[0].delta.content or ""
            if delta:
                yield delta
