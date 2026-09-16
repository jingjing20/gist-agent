import type { GenerationErrorCode } from '@gist/contracts';

export class GenerationExecutionError extends Error {
    constructor(
        readonly code: GenerationErrorCode,
        message: string
    ) {
        super(message);
        this.name = 'GenerationExecutionError';
    }
}

export function normalizeGenerationError(
    error: unknown,
    context: { ownershipLost: boolean; aborted: boolean }
): { code: GenerationErrorCode; message: string; stack?: string } {
    if (error instanceof GenerationExecutionError) {
        return { code: error.code, message: error.message, stack: error.stack };
    }

    if (context.ownershipLost) {
        return {
            code: 'WRITER_OWNERSHIP_LOST',
            message: '生成任务写入权已丢失',
            stack: error instanceof Error ? error.stack : undefined,
        };
    }

    if (context.aborted) {
        return {
            code: 'CANCELLED',
            message: '已取消',
            stack: error instanceof Error ? error.stack : undefined,
        };
    }

    return {
        code: 'INTERNAL_ERROR',
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
    };
}
