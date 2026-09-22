import { AnalysisRuntimeAdapter } from '../analysis/analysis-runtime-adapter';
import { ANALYSIS_RUNTIME_VERSIONS } from '@gist/contracts';
import { Injectable, Logger } from '@nestjs/common';
import { ConversationService } from '../conversation/conversation.service';
import { GenerationService, type GenerationIdentity } from './generation.service';
import type { SSEEvent } from './tools/base-tool';
import type OpenAI from 'openai';
import { randomUUID } from 'crypto';
import { GenerationReliabilityService, type GenerationPermit } from './generation-reliability.service';
import { workerConfig } from '@gist/config';
import type { GenerationStatus } from '@gist/contracts';
import type { GenerationErrorCode } from '@gist/contracts';
import { GenerationExecutionError, normalizeGenerationError } from './generation-errors';
import type { GenerationExecutionMetrics } from './generation.service';

// Timeout, cancellation and writer ownership remain responsibilities of the generation shell.
const CHAT_TIMEOUT_MS = Math.max(100, Number(process.env.CHAT_TIMEOUT_MS) || 120_000);

/**
 * 对话核心服务：编排 LLM 思考流程、管理上下文、触发工具执行并实时推送结果。
 */
@Injectable()
export class ChatService {
    private readonly logger = new Logger(ChatService.name);

    constructor(
        private readonly conversationService: ConversationService,
        private readonly generations: GenerationService,
        private readonly reliability: GenerationReliabilityService,
        private readonly analysisRuntime: AnalysisRuntimeAdapter
    ) {}

    async executeGeneration(generationId: string): Promise<void> {
        const candidate = await this.generations.candidate(generationId);
        if (!candidate || ['completed', 'failed', 'cancelled'].includes(candidate.status)) return;
        if (candidate.status === 'cancel_requested') {
            const identity = { ...candidate, writerToken: '' };
            await this.generations.finalize(identity, 'cancelled', undefined, 'CANCELLED', { type: 'done', status: 'cancelled', errorCode: 'CANCELLED' });
            return;
        }
        if (candidate.status !== 'pending') return;

        const writerToken = randomUUID();
        let permit: GenerationPermit | null = await this.reliability.acquire({
            generationId,
            userId: candidate.userId,
            provider: process.env.LLM_PROVIDER || 'openai-compatible',
            token: writerToken,
        });
        if (!permit) throw new GenerationExecutionError('GENERATION_CAPACITY_UNAVAILABLE', '生成容量暂时不可用');
        const generation = await this.generations.claim(generationId, writerToken);
        if (!generation) {
            await this.reliability.release(permit);
            return;
        }

        const environment = workerConfig();
        let ownershipLost = false;
        const heartbeat = setInterval(
            () =>
                void Promise.all([this.generations.heartbeat(generationId, writerToken), this.reliability.renew(permit!)]).then(([databaseOwned, redisOwned]) => {
                    ownershipLost = !databaseOwned || !redisOwned;
                }),
            environment.heartbeatIntervalMs
        );
        heartbeat.unref();
        try {
            const request = await this.conversationService.getMessage(generation.requestMessageId, generation.conversationId, generation.userId);
            if (ownershipLost) throw new Error('WRITER_OWNERSHIP_LOST');
            await this.runGeneration(generation, request?.content ?? '', generation.datasourceId, () => ownershipLost);
        } finally {
            clearInterval(heartbeat);
            await this.reliability.release(permit);
            permit = null;
        }
    }

    private async runGeneration(generation: GenerationIdentity, message: string, datasourceId: number | null, ownershipLost: () => boolean): Promise<void> {
        const { conversationId, userId } = generation;
        const newCore = generation.promptPolicyVersion === ANALYSIS_RUNTIME_VERSIONS.promptPolicy;
        const controller = new AbortController();
        const signal = controller.signal;
        const emitter = this.generations.emitter(generation);
        const blocks: SSEEvent[] = [];
        const turnMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];
        let timedOut = false;
        const cancelPoll = setInterval(() => {
            if (ownershipLost()) controller.abort(new GenerationExecutionError('WRITER_OWNERSHIP_LOST', '生成任务写入权已丢失'));
            else void this.generations.isCancelRequested(generation.id).then((cancelled) => cancelled && controller.abort(new GenerationExecutionError('CANCELLED', '已取消')));
        }, 500);
        const timeout = setTimeout(
            () => {
                timedOut = true;
                controller.abort(new GenerationExecutionError('ANALYSIS_TIMEOUT', '分析超时，请尝试简化问题后重试'));
            },
            Math.min(CHAT_TIMEOUT_MS, 120_000)
        );
        timeout.unref();
        let terminal: SSEEvent = { type: 'done' };
        let finalStatus: GenerationStatus = 'completed';
        let errorDetail: string | undefined;
        let errorCode: GenerationErrorCode | undefined;
        const metrics: GenerationExecutionMetrics = {
            llmCallCount: 0,
            toolCallCount: 0,
            sqlCallCount: 0,
            inputTokensEstimated: 0,
            outputTokensEstimated: 0,
        };

        // 全局定时器与用户取消共用同一 AbortController。
        // 超时时先 abort LLM/工具/SQL，等执行栈退出后再写终态。
        try {
            if (!newCore) throw new GenerationExecutionError('ANALYSIS_PROTOCOL_ERROR', '任务分析协议版本与当前 Worker 不匹配');
            await this.analysisRuntime.run({
                generation,
                message,
                signal,
                emitter,
                blocks,
                turnMessages,
                metrics,
                assertWritable: () => this.generations.assertWritable(generation),
                checkpoint: () => this.generations.checkpointMessage(generation, blocks, turnMessages),
                onFirstDelta: () => this.generations.markFirstDelta(generation),
            });
            if (signal.aborted) throw new GenerationExecutionError('CANCELLED', '已取消');
        } catch (err: unknown) {
            const cause = signal.aborted && signal.reason instanceof Error ? signal.reason : err;
            const normalized = normalizeGenerationError(cause, { ownershipLost: ownershipLost(), aborted: signal.aborted && !timedOut });
            this.logger.error(`handleChat failed conversationId=${conversationId} userId=${userId} code=${normalized.code}: ${normalized.message}`, normalized.stack);
            blocks.push({ type: 'error', content: normalized.message, errorCode: normalized.code });
            finalStatus = normalized.code === 'CANCELLED' ? 'cancelled' : 'failed';
            errorDetail = normalized.message;
            errorCode = normalized.code;
            await this.generations.recordSpan(generation, 'generation.error', Date.now(), 'error', { errorCode: normalized.code }).catch(() => undefined);
            terminal =
                finalStatus === 'cancelled'
                    ? { type: 'done', status: 'cancelled', errorCode: normalized.code }
                    : { type: 'done', status: 'failed', error: normalized.message, errorCode: normalized.code };
        }
        clearInterval(cancelPoll);
        clearTimeout(timeout);

        try {
            await this.generations.recordExecutionMetrics(generation, metrics);
        } catch (metricError) {
            this.logger.warn(`Failed to persist generation metrics: ${metricError instanceof Error ? metricError.message : metricError}`);
        }

        try {
            await this.generations.drain(generation);
        } catch (drainError) {
            if (finalStatus === 'completed') throw drainError;
        }
        let finalized: boolean;
        try {
            finalized = await this.generations.finalize(generation, finalStatus, errorDetail, errorCode, terminal, { blocks, llmMessages: turnMessages });
        } catch (error) {
            if (!newCore || !(error instanceof Error) || !['ANALYSIS_STATE_CONFLICT', 'ANALYSIS_DRAFT_MISSING'].includes(error.message)) throw error;
            finalStatus = 'failed';
            const detail = '分析状态提交冲突，本轮草稿未提升；请重新发起分析';
            blocks.push({ type: 'error', content: detail, errorCode: 'INTERNAL_ERROR' });
            finalized = await this.generations.finalize(
                generation,
                'failed',
                detail,
                'INTERNAL_ERROR',
                { type: 'done', status: 'failed', error: detail, errorCode: 'INTERNAL_ERROR' },
                { blocks, llmMessages: turnMessages }
            );
        }
        if (!finalized && finalStatus === 'completed' && (await this.generations.isCancelRequested(generation.id))) {
            finalStatus = 'cancelled';
            finalized = await this.generations.finalize(
                generation,
                'cancelled',
                undefined,
                'CANCELLED',
                { type: 'done', status: 'cancelled', errorCode: 'CANCELLED' },
                { blocks, llmMessages: turnMessages }
            );
        }
    }
}
