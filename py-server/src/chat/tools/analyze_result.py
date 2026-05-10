from typing import Any

from chat.tools.base import Tool, ToolContext, ToolExecutionResult


class AnalyzeResultTool(Tool):
    @property
    def name(self) -> str:
        return "analyze_result"

    @property
    def definition(self) -> dict[str, Any]:
        return {
            "type": "function",
            "function": {
                "name": "analyze_result",
                "description": (
                    "查询数据后必须调用此工具，判断是否需要图表可视化。必须在 execute_sql_query 之后、"
                    "generate_chart 之前调用。不要在此工具中放分析结论，结论在所有工具调用完成后以文字形式输出。"
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "needsChart": {
                            "type": "boolean",
                            "description": (
                                "数据是否适合可视化。趋势/时序/对比/排名/分布 -> true；"
                                "简单数值/是否判断 -> false"
                            ),
                        },
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
                            "description": (
                                "图表类型（needsChart=true 时必填）：line 趋势时序 / "
                                "bar 对比排名 / pie 占比 / scatter 相关性 / radar 多维对比 / "
                                "funnel 阶段转化"
                            ),
                        },
                        "chartTitle": {
                            "type": "string",
                            "description": "图表标题（needsChart=true 时必填）",
                        },
                    },
                    "required": ["needsChart"],
                },
            },
        }

    async def execute(
        self, args: dict[str, Any], ctx: ToolContext
    ) -> ToolExecutionResult:
        if args.get("needsChart"):
            # 在此处提前预告图表，前端立即渲染骨架屏；
            # 真实窗口期 = 下一轮 LLM 生成 generate_chart arguments 的耗时（通常数秒～数十秒）。
            # 不能等到收到 generate_chart 的 tool_call delta 才发——非流式厂商一次性返回时窗口会被压成 0。
            ctx.emitter.send({"type": "chart_loading"})
            return ToolExecutionResult(
                tool_result=(
                    f"图表区域已就绪，请立即调用 generate_chart 提供完整数据"
                    f"（chartType: \"{args.get('chartType')}\", "
                    f"title: \"{args.get('chartTitle')}\"）。"
                    "图表生成完成后再输出文字总结。"
                ),
                blocks=[],
            )
        return ToolExecutionResult(
            tool_result="无需图表。请直接输出文字分析总结。", blocks=[]
        )
