import { Injectable } from '@nestjs/common';
import { DatabaseService, type QueryRow } from '../database/database.service';

export interface OperationsDashboardBucket {
    modelProvider: string; modelName: string; promptPolicyVersion: string; toolsetVersion: string;
    contextPolicyVersion: string; memoryPolicyVersion: string; schemaContextVersion: string;
    generations: number; completed: number; failed: number; cancelled: number; successRate: number;
    p95TotalLatencyMs: number; p95FirstTokenMs: number; inputTokensEstimated: number;
    outputTokensEstimated: number; estimatedCostMicrousd: number; toolCalls: number; sqlCalls: number;
}

@Injectable()
export class OperationsService {
    constructor(private readonly db: DatabaseService) {}

    async dashboard(userId: number, requestedDays: number): Promise<{ windowDays: number; buckets: OperationsDashboardBucket[]; qualityEvaluations: QueryRow[] }> {
        const windowDays = Math.min(90, Math.max(1, Math.floor(requestedDays || 7)));
        const rows = await this.db.query<QueryRow[]>(
            `SELECT
                g.model_provider,g.model_name,g.prompt_policy_version,g.toolset_version,
                g.context_policy_version,g.memory_policy_version,g.schema_context_version,
                COUNT(*)::int AS generations,
                COUNT(*) FILTER (WHERE g.status='completed')::int AS completed,
                COUNT(*) FILTER (WHERE g.status='failed')::int AS failed,
                COUNT(*) FILTER (WHERE g.status='cancelled')::int AS cancelled,
                COALESCE(ROUND(100.0 * COUNT(*) FILTER (WHERE g.status='completed') / NULLIF(COUNT(*),0),2),0) AS success_rate,
                COALESCE(ROUND(PERCENTILE_CONT(0.95) WITHIN GROUP (
                    ORDER BY EXTRACT(EPOCH FROM (g.completed_at-g.created_at))*1000
                ) FILTER (WHERE g.completed_at IS NOT NULL)),0) AS p95_total_latency_ms,
                COALESCE(ROUND(PERCENTILE_CONT(0.95) WITHIN GROUP (
                    ORDER BY EXTRACT(EPOCH FROM (g.first_token_at-g.started_at))*1000
                ) FILTER (WHERE g.first_token_at IS NOT NULL AND g.started_at IS NOT NULL)),0) AS p95_first_token_ms,
                COALESCE(SUM(m.input_tokens_estimated),0)::bigint AS input_tokens_estimated,
                COALESCE(SUM(m.output_tokens_estimated),0)::bigint AS output_tokens_estimated,
                COALESCE(SUM(m.estimated_cost_microusd),0)::bigint AS estimated_cost_microusd,
                COALESCE(SUM(m.tool_call_count),0)::bigint AS tool_calls,
                COALESCE(SUM(m.sql_call_count),0)::bigint AS sql_calls
             FROM generation g
             LEFT JOIN generation_metric m ON m.generation_id=g.id
             WHERE g.user_id=? AND g.created_at >= NOW() - (? * INTERVAL '1 day')
             GROUP BY g.model_provider,g.model_name,g.prompt_policy_version,g.toolset_version,
                      g.context_policy_version,g.memory_policy_version,g.schema_context_version
             ORDER BY generations DESC`,
            [userId, windowDays]
        );
        const qualityEvaluations = await this.db.query<QueryRow[]>(
            `SELECT benchmark_version,model_provider,model_name,prompt_policy_version,toolset_version,
                    context_policy_version,memory_policy_version,schema_context_version,case_count,
                    overall_score,pass_rate,schema_recall,p95_total_latency_ms,average_cost_microusd,gate_passed,created_at
               FROM agent_evaluation_run
              WHERE created_at >= NOW() - (? * INTERVAL '1 day')
              ORDER BY created_at DESC LIMIT 20`,
            [windowDays]
        );
        return {
            windowDays,
            buckets: rows.map((row) => ({
                modelProvider: row.model_provider,
                modelName: row.model_name,
                promptPolicyVersion: row.prompt_policy_version,
                toolsetVersion: row.toolset_version,
                contextPolicyVersion: row.context_policy_version,
                memoryPolicyVersion: row.memory_policy_version,
                schemaContextVersion: row.schema_context_version,
                generations: Number(row.generations),
                completed: Number(row.completed),
                failed: Number(row.failed),
                cancelled: Number(row.cancelled),
                successRate: Number(row.success_rate),
                p95TotalLatencyMs: Number(row.p95_total_latency_ms),
                p95FirstTokenMs: Number(row.p95_first_token_ms),
                inputTokensEstimated: Number(row.input_tokens_estimated),
                outputTokensEstimated: Number(row.output_tokens_estimated),
                estimatedCostMicrousd: Number(row.estimated_cost_microusd),
                toolCalls: Number(row.tool_calls),
                sqlCalls: Number(row.sql_calls),
            })),
            qualityEvaluations,
        };
    }

    async trace(userId: number, generationId: string) {
        const generations = await this.db.query<QueryRow[]>('SELECT id FROM generation WHERE id=? AND user_id=?', [generationId, userId]);
        if (!generations.length) return null;
        return this.db.query<QueryRow[]>(
            `SELECT name,status,duration_ms,metadata,created_at
               FROM generation_trace_span WHERE generation_id=? ORDER BY created_at,id`,
            [generationId]
        );
    }
}
