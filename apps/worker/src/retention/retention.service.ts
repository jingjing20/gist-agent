import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { DatabaseService, type QueryRow } from '../database/database.service';

type ResourceType = 'query_artifact' | 'generation_event' | 'memory_record';

@Injectable()
export class RetentionService implements OnApplicationBootstrap, OnApplicationShutdown {
    private readonly logger = new Logger(RetentionService.name);
    private timer?: NodeJS.Timeout;

    constructor(private readonly db: DatabaseService) {}

    onApplicationBootstrap(): void {
        if (process.env.RETENTION_CLEANUP_ENABLED === '0') return;
        const intervalMs = Math.max(60_000, Number(process.env.RETENTION_CLEANUP_INTERVAL_MS) || 24 * 60 * 60 * 1000);
        this.timer = setInterval(() => void this.runOnce().catch((error) => this.logger.error(`Retention cleanup failed: ${error.message}`)), intervalMs);
        this.timer.unref();
    }

    onApplicationShutdown(): void {
        if (this.timer) clearInterval(this.timer);
    }

    async runOnce(): Promise<Record<ResourceType, number>> {
        const policies = await this.db.query<QueryRow[]>(
            `SELECT resource_type,retention_days FROM retention_policy WHERE enabled=TRUE ORDER BY resource_type`
        );
        const result = { query_artifact: 0, generation_event: 0, memory_record: 0 };
        for (const policy of policies) {
            const resource = policy.resource_type as ResourceType;
            const days = Number(policy.retention_days);
            if (!(resource in result) || !Number.isInteger(days) || days <= 0) continue;
            result[resource] = await this.cleanupResource(resource, days);
        }
        return result;
    }

    private async cleanupResource(resource: ResourceType, retentionDays: number): Promise<number> {
        const startedAt = new Date();
        const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
        try {
            const deleted = await this.db.withTransaction(async (transaction) => {
                const sql =
                    resource === 'query_artifact'
                        ? `DELETE FROM query_artifact WHERE created_at < ? OR (expires_at IS NOT NULL AND expires_at <= NOW())`
                        : resource === 'generation_event'
                          ? `DELETE FROM generation_event WHERE created_at < ?`
                          : `DELETE FROM memory_record
                              WHERE (expires_at IS NOT NULL AND expires_at <= NOW())
                                 OR (status IN ('deleted','superseded') AND updated_at < ?)`;
                const [deletion] = await transaction.execute(sql, [cutoff.toISOString()]);
                await transaction.execute(
                    `INSERT INTO retention_cleanup_audit
                        (resource_type,cutoff_at,deleted_count,status,started_at,completed_at)
                     VALUES (?,?,?,'completed',?,NOW())`,
                    [resource, cutoff.toISOString(), deletion.rowCount, startedAt.toISOString()]
                );
                return deletion.rowCount;
            });
            return deleted;
        } catch (error) {
            await this.db.execute(
                `INSERT INTO retention_cleanup_audit
                    (resource_type,cutoff_at,deleted_count,status,error_code,started_at,completed_at)
                 VALUES (?,?,0,'failed','RETENTION_CLEANUP_FAILED',?,NOW())`,
                [resource, cutoff.toISOString(), startedAt.toISOString()]
            ).catch(() => undefined);
            throw error;
        }
    }
}
