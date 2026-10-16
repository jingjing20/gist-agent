import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { Worker } from 'bullmq';
import { ChatService } from './chat.service';
import { GENERATION_QUEUE_NAME, parseGenerationJob, type GenerationJob } from '@gist/contracts';
import { workerConfig } from '@gist/config';

@Injectable()
export class GenerationWorkerService implements OnApplicationBootstrap, OnApplicationShutdown {
    private readonly logger = new Logger(GenerationWorkerService.name);
    private worker?: Worker<GenerationJob>;
    constructor(private readonly chat: ChatService) {}
    onApplicationBootstrap() {
        const environment = workerConfig();
        this.worker = new Worker<GenerationJob>(
            GENERATION_QUEUE_NAME,
            async (job) => {
                const payload = parseGenerationJob(job.data);
                await this.chat.executeGeneration(payload.generationId);
            },
            {
                connection: { url: environment.redisUrl },
                concurrency: environment.concurrency,
            }
        );
        this.worker.on('ready', () => this.logger.log('Generation worker ready'));
        this.worker.on('failed', (job, error) => {
            this.logger.error(`Generation job failed id=${job?.id}: ${error.message}`);
            if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) {
                void this.chat.failQueued(job.data.generationId, '任务重试已耗尽，请重新分析').catch((failure) => this.logger.error(String(failure)));
            }
        });
    }
    async onApplicationShutdown() {
        await this.worker?.close();
    }
}
