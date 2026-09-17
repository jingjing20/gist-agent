import type { GenerationErrorCode } from '@gist/contracts';
import { GenerationExecutionError } from './generation-errors';
import type { ToolRegistry } from './tools/tool-registry';

export type AgentState = 'UNDERSTANDING' | 'QUERYING' | 'RESULT_VALIDATION' | 'CHART_PLANNING' | 'SYNTHESIZING' | 'COMPLETED' | 'FAILED';
export type AgentOutcome = { kind: 'completed'; state: 'COMPLETED' } | { kind: 'failed'; state: 'FAILED'; code: GenerationErrorCode };

export interface ProposedToolCall {
    id?: string;
    function: { name: string; arguments: string };
}

export class AgentOrchestrator {
    private state: AgentState = 'UNDERSTANDING';
    private hasQueryResult = false;

    getState(): AgentState {
        return this.state;
    }

    parseBatch(calls: ProposedToolCall[], registry: ToolRegistry): Array<{ call: ProposedToolCall; args: Record<string, unknown> }> {
        // A chart must be planned from a result observed in an earlier model iteration.
        // A query earlier in the same batch is deliberately not accepted as evidence.
        if (calls.some((call) => call.function.name === 'generate_chart') && !this.hasQueryResult) {
            this.fail('INVALID_STATE_TRANSITION', 'generate_chart 只能在已完成数据查询后调用');
        }

        return calls.map((call) => {
            const tool = registry.get(call.function.name);
            if (!tool) this.fail('INVALID_STATE_TRANSITION', `工具 ${call.function.name} 不存在或已下线`);
            let raw: unknown;
            try {
                raw = JSON.parse(call.function.arguments);
            } catch {
                this.fail('INVALID_TOOL_ARGUMENTS', `${call.function.name} 参数不是有效 JSON`);
            }
            try {
                return { call, args: tool!.parseArguments(raw) };
            } catch (error) {
                this.fail('INVALID_TOOL_ARGUMENTS', `${call.function.name} 参数无效: ${error instanceof Error ? error.message : String(error)}`);
            }
        });
    }

    beforeTool(name: string): void {
        if (name === 'execute_sql_query') {
            if (!['UNDERSTANDING', 'RESULT_VALIDATION', 'SYNTHESIZING'].includes(this.state)) {
                this.fail('INVALID_STATE_TRANSITION', `状态 ${this.state} 不允许执行查询`);
            }
            this.state = 'QUERYING';
            return;
        }
        if (name === 'generate_chart') {
            if (!this.hasQueryResult || !['RESULT_VALIDATION', 'SYNTHESIZING'].includes(this.state)) {
                this.fail('INVALID_STATE_TRANSITION', `状态 ${this.state} 不允许生成图表`);
            }
            this.state = 'CHART_PLANNING';
            return;
        }
        this.fail('INVALID_STATE_TRANSITION', `工具 ${name} 不在允许的工作流中`);
    }

    afterTool(name: string, succeeded = true): void {
        if (name === 'execute_sql_query') {
            this.hasQueryResult ||= succeeded;
            this.state = 'RESULT_VALIDATION';
        } else if (name === 'generate_chart') {
            this.state = 'SYNTHESIZING';
        }
    }

    complete(): AgentOutcome {
        this.state = 'COMPLETED';
        return { kind: 'completed', state: 'COMPLETED' };
    }

    exhausted(): never {
        this.fail('MAX_AGENT_ITERATIONS_EXCEEDED', 'Agent 已达到最大迭代次数，未能生成最终答案');
    }

    private fail(code: GenerationErrorCode, message: string): never {
        this.state = 'FAILED';
        throw new GenerationExecutionError(code, message);
    }
}
