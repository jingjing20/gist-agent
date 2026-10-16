import { config as loadDotenv } from 'dotenv';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

let loaded = false;

export function loadWorkspaceEnv(): void {
    if (loaded) return;
    const candidates = [resolve(process.cwd(), '.env'), resolve(process.cwd(), '../../.env')];
    const envPath = candidates.find(existsSync);
    if (envPath) loadDotenv({ path: envPath });
    loaded = true;
}

function numberEnv(name: string, fallback: number): number {
    const value = Number(process.env[name]);
    return Number.isFinite(value) && value > 0 ? value : fallback;
}

export interface DatabaseConfig {
    host: string;
    port: number;
    user: string;
    password: string;
    database: string;
    max: number;
}

export function databaseConfig(): DatabaseConfig {
    loadWorkspaceEnv();
    return {
        host: process.env.DB_HOST || '127.0.0.1',
        port: numberEnv('DB_PORT', 5432),
        user: process.env.DB_USER || 'postgres',
        password: process.env.DB_PASSWORD || '',
        database: process.env.DB_NAME || 'gist_agent',
        max: numberEnv('DB_POOL_MAX', 10),
    };
}

/** Dedicated least-privilege connection used only for Agent-authored queries. */
export function agentDatabaseConfig(): DatabaseConfig {
    const base = databaseConfig();
    if (process.env.NODE_ENV === 'production' && (!process.env.AGENT_DB_USER || !process.env.AGENT_DB_PASSWORD)) {
        throw new Error('生产环境必须配置 AGENT_DB_USER 和 AGENT_DB_PASSWORD，禁止 Agent 复用应用数据库账号');
    }
    return {
        ...base,
        user: process.env.AGENT_DB_USER || base.user,
        password: process.env.AGENT_DB_PASSWORD || base.password,
        max: numberEnv('AGENT_DB_POOL_MAX', 4),
    };
}

export interface WorkerConfig {
    redisUrl: string;
    eventKeyPrefix: string;
    concurrency: number;
    healthPort: number;
    heartbeatIntervalMs: number;
    leaseTtlMs: number;
    semaphoreWaitMs: number;
    globalConcurrency: number;
    providerConcurrency: number;
    userConcurrency: number;
}

export function workerConfig(): WorkerConfig {
    loadWorkspaceEnv();
    return {
        redisUrl: process.env.REDIS_URL || 'redis://127.0.0.1:6379',
        eventKeyPrefix: process.env.EVENT_KEY_PREFIX || 'gist-agent',
        concurrency: numberEnv('WORKER_CONCURRENCY', 5),
        healthPort: numberEnv('WORKER_HEALTH_PORT', 3001),
        heartbeatIntervalMs: numberEnv('GENERATION_HEARTBEAT_INTERVAL_MS', 5_000),
        leaseTtlMs: numberEnv('GENERATION_LEASE_TTL_MS', 20_000),
        semaphoreWaitMs: numberEnv('GENERATION_SEMAPHORE_WAIT_MS', 2_000),
        globalConcurrency: numberEnv('GENERATION_GLOBAL_CONCURRENCY', 20),
        providerConcurrency: numberEnv('GENERATION_PROVIDER_CONCURRENCY', 10),
        userConcurrency: numberEnv('USER_GENERATION_CONCURRENCY_LIMIT', 5),
    };
}

export function jwtSecret(): string {
    loadWorkspaceEnv();
    const secret = process.env.JWT_SECRET?.trim();
    if (!secret || (process.env.NODE_ENV === 'production' && secret.length < 32) || secret === 'default-secret' || secret === 'your-jwt-secret-change-in-production') {
        throw new Error('JWT_SECRET 必须配置为独立的有效签名密钥');
    }
    return secret;
}
