from typing import Any

from chat.tools.base import Tool, ToolContext, ToolExecutionResult


class GenerateChartTool(Tool):
    @property
    def name(self) -> str:
        return "generate_chart"

    @property
    def definition(self) -> dict[str, Any]:
        return {
            "type": "function",
            "function": {
                "name": "generate_chart",
                "description": (
                    "仅在 analyze_result 返回 needsChart=true 后调用。提供完整的图表数据，"
                    "样式由前端统一处理。"
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "chartType": {
                            "type": "string",
                            "enum": [
                                "line",
                                "bar",
                                "pie",
                                "scatter",
                                "radar",
                                "funnel",
                            ],
                            "description": "图表类型，与 analyze_result 中声明的一致",
                        },
                        "title": {
                            "type": "string",
                            "description": "图表标题，与 analyze_result 中声明的一致",
                        },
                        "xAxis": {
                            "type": "array",
                            "items": {"type": "string"},
                            "description": (
                                "各数据点的标签；bar/line/scatter 为 X 轴分类，"
                                "pie/funnel 为各扇区名称，radar 为多维指标名称"
                                "（必填，长度需对应数据）"
                            ),
                        },
                        "series": {
                            "type": "array",
                            "description": "数据系列",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "name": {
                                        "type": "string",
                                        "description": "系列名称",
                                    },
                                    "data": {
                                        "type": "array",
                                        "items": {"type": "number"},
                                        "description": "数值数组，与 xAxis 一一对应",
                                    },
                                },
                                "required": ["name", "data"],
                            },
                        },
                    },
                    "required": ["chartType", "title", "series"],
                },
            },
        }

    async def execute(
        self, args: dict[str, Any], ctx: ToolContext
    ) -> ToolExecutionResult:
        chart_data = {
            "chartType": args.get("chartType"),
            "title": args.get("title"),
            "xAxis": args.get("xAxis"),
            "series": args.get("series"),
        }
        chart_event = {"type": "chart", "chartData": chart_data}
        ctx.emitter.send(chart_event)
        return ToolExecutionResult(
            tool_result="图表已成功渲染到用户界面。", blocks=[chart_event]
        )
