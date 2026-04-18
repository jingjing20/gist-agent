from chat.tools.base import Tool


class ToolRegistry:
    def __init__(self, tools: list[Tool]):
        self._tools = {t.name: t for t in tools}

    def get_definitions(self) -> list[dict]:
        return [t.definition for t in self._tools.values()]

    def get(self, name: str) -> Tool | None:
        return self._tools.get(name)
