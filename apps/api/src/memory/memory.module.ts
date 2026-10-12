import { Module, Controller, Get, Post, Patch, Delete, Body, Param, Query, HttpCode, HttpException, Injectable } from '@nestjs/common';
import { MemoryRepository, MemoryError, positiveInteger } from '@gist/database';
import { DatabaseService } from '../database/database.service';
import { CurrentUser } from '../auth/user.decorator';
import type { User } from '../auth/auth.service';

@Injectable()
class Memories extends MemoryRepository {
    constructor(db: DatabaseService) {
        super(db);
    }
}
async function http<T>(fn: () => Promise<T>): Promise<T> {
    try {
        return await fn();
    } catch (e) {
        if (e instanceof MemoryError) throw new HttpException(e.message, e.status);
        throw e;
    }
}
function bodyObject(body: unknown): Record<string, unknown> {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new MemoryError(400, '请求体必须为对象');
    return body as Record<string, unknown>;
}
@Controller('memories')
class MemoryController {
    constructor(private readonly memories: Memories) {}
    @Get() list(@CurrentUser() user: User, @Query() q: Record<string, string>) {
        return http(() =>
            this.memories.list(user.id, positiveInteger(q.datasourceId), {
                q: q.q,
                cursor: q.cursor,
                limit: q.limit === undefined ? undefined : positiveInteger(q.limit),
            })
        );
    }
    @Get(':id') get(@CurrentUser() user: User, @Param('id') id: string, @Query('version') version?: string) {
        return http(() => this.memories.get(user.id, id, version === undefined ? undefined : positiveInteger(version)));
    }
    @Post('related') related(@CurrentUser() user: User, @Body() body: unknown) {
        return http(() => {
            const b = bodyObject(body);
            if (Object.keys(b).some((k) => !['datasourceId', 'content', 'excludeId'].includes(k))) throw new MemoryError(400, '存在不允许的字段');
            if (b.excludeId !== undefined && typeof b.excludeId !== 'string') throw new MemoryError(400, '记忆 ID 格式错误');
            return this.memories.related(user.id, positiveInteger(b.datasourceId), b.content, b.excludeId as string | undefined);
        });
    }
    @Post() create(@CurrentUser() user: User, @Body() body: unknown) {
        return http(() => {
            const { datasourceId, ...content } = bodyObject(body);
            return this.memories.create(user.id, positiveInteger(datasourceId), content);
        });
    }
    @Patch(':id') update(@CurrentUser() user: User, @Param('id') id: string, @Body() body: unknown) {
        return http(() => {
            const { expectedVersion, ...patch } = bodyObject(body);
            return this.memories.update(user.id, id, positiveInteger(expectedVersion), patch);
        });
    }
    @Delete(':id') @HttpCode(204) remove(@CurrentUser() user: User, @Param('id') id: string, @Query('expectedVersion') version: string) {
        return http(async () => {
            await this.memories.update(user.id, id, positiveInteger(version), {}, true);
        });
    }
}
@Controller('memory-candidates')
class CandidateController {
    constructor(private readonly memories: Memories) {}
    @Get() list(@CurrentUser() user: User, @Query('datasourceId') ds: string, @Query('conversationId') conversation?: string) {
        return http(() => this.memories.candidates(user.id, positiveInteger(ds), conversation));
    }
    private decide(user: User, id: string, body: unknown, accept: boolean) {
        return http(() => {
            const b = bodyObject(body);
            const allowed = accept ? ['expectedVersion', 'content', 'memoryId', 'expectedMemoryVersion'] : ['expectedVersion'];
            if (Object.keys(b).some((k) => !allowed.includes(k))) throw new MemoryError(400, '存在不允许的字段');
            if (b.memoryId !== undefined && (typeof b.memoryId !== 'string' || b.content === undefined)) throw new MemoryError(400, '替换记忆需要完整内容和目标 ID');
            if (b.expectedMemoryVersion !== undefined && b.memoryId === undefined) throw new MemoryError(400, '请选择要替换的记忆');
            return this.memories.decide(
                user.id,
                id,
                positiveInteger(b.expectedVersion),
                accept,
                b.content === undefined
                    ? undefined
                    : {
                          content: b.content,
                          memoryId: b.memoryId as string | undefined,
                          expectedMemoryVersion: b.expectedMemoryVersion === undefined ? undefined : positiveInteger(b.expectedMemoryVersion),
                      }
            );
        });
    }
    @Post(':id/confirm') confirm(@CurrentUser() user: User, @Param('id') id: string, @Body() body: unknown) {
        return this.decide(user, id, body, true);
    }
    @Post(':id/reject') reject(@CurrentUser() user: User, @Param('id') id: string, @Body() body: unknown) {
        return this.decide(user, id, body, false);
    }
}
@Module({ controllers: [MemoryController, CandidateController], providers: [Memories] })
export class MemoryModule {}
