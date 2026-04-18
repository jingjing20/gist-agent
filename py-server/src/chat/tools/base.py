"""Tool 协议：与 Nest base-tool.ts 完全对齐。
Tool.execute 返回 {toolResult, blocks}，其中 blocks 用于持久化。
"""

import abc
from dataclasses import dataclass, field
from typing import Any

from chat.stream_emitter import StreamEmitter


@dataclass
class ToolContext:
    emitter: StreamEmitter
    datasource_id: int | None = None
    user_id: int | None = None


@dataclass
class ToolExecutionResult:
    tool_result: str
    blocks: list[dict[str, Any]] = field(default_factory=list)


class Tool(abc.ABC):
    @property
    @abc.abstractmethod
    def name(self) -> str: ...

    @property
    @abc.abstractmethod
    def definition(self) -> dict[str, Any]:
        """OpenAI function-calling schema。"""

    @abc.abstractmethod
    async def execute(
        self, args: dict[str, Any], ctx: ToolContext
    ) -> ToolExecutionResult: ...
