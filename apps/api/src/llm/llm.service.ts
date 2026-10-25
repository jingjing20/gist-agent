import { shutdownTelemetry } from '@gist/telemetry';
import { Injectable } from '@nestjs/common';
import { LlmClient } from '@gist/llm';

@Injectable()
export class LlmService extends LlmClient {
    async onApplicationShutdown() {
        await shutdownTelemetry();
    }
}
