import asyncio
import json
from typing import Any, AsyncIterator


class StreamEmitter:
    """SSE 发射器：queue 桥接同步 send() 与异步 HTTP 流。
    与 Nest 的 res.write 对齐，send() 是同步调用。
    """

    def __init__(self):
        self._queue: asyncio.Queue[str | None] = asyncio.Queue()

    def send(self, event: dict[str, Any]) -> None:
        # default=str 与 Nest 的 JSON.stringify 对齐：datetime/date/Decimal 等
        # DB 常返类型统一转字符串，否则 json.dumps 会抛 "not JSON serializable"
        self._queue.put_nowait(
            f"data: {json.dumps(event, ensure_ascii=False, default=str)}\n\n"
        )

    def done(self) -> None:
        self.send({"type": "done"})
        self._queue.put_nowait(None)

    def end(self) -> None:
        """终止流（不发 done 事件，用于强制关闭场景）。"""
        self._queue.put_nowait(None)

    async def stream(self) -> AsyncIterator[str]:
        while True:
            chunk = await self._queue.get()
            if chunk is None:
                break
            yield chunk
