import { Module, Controller, Get, Post, Patch, Delete, Body, Param, Query, HttpCode, HttpException, Injectable } from '@nestjs/common';
import { BusinessDefinitionRepository, DefinitionError, positiveInteger } from '@gist/database';
import { DatabaseService } from '../database/database.service';
import { CurrentUser } from '../auth/user.decorator';
import type { User } from '../auth/auth.service';

@Injectable()
class Definitions extends BusinessDefinitionRepository {
    constructor(db: DatabaseService) {
        super(db);
    }
}
async function http<T>(fn: () => Promise<T>): Promise<T> {
    try {
        return await fn();
    } catch (e) {
        if (e instanceof DefinitionError) throw new HttpException(e.message, e.status);
        throw e;
    }
}
function bodyObject(body: unknown): Record<string, unknown> {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new DefinitionError(400, '请求体必须为对象');
    return body as Record<string, unknown>;
}
@Controller('business-definitions')
class DefinitionController {
    constructor(private readonly definitions: Definitions) {}
    @Get() list(@CurrentUser() user: User, @Query() q: Record<string, string>) {
        return http(() =>
            this.definitions.list(user.id, positiveInteger(q.datasourceId), {
                type: q.type,
                q: q.q,
                cursor: q.cursor,
                limit: q.limit === undefined ? undefined : positiveInteger(q.limit),
            })
        );
    }
    @Get(':id') get(@CurrentUser() user: User, @Param('id') id: string, @Query('version') version?: string) {
        return http(() => this.definitions.get(user.id, id, version === undefined ? undefined : positiveInteger(version)));
    }
    @Post() create(@CurrentUser() user: User, @Body() body: unknown) {
        return http(() => {
            const { datasourceId, ...content } = bodyObject(body);
            return this.definitions.create(user.id, positiveInteger(datasourceId), content);
        });
    }
    @Patch(':id') update(@CurrentUser() user: User, @Param('id') id: string, @Body() body: unknown) {
        return http(() => {
            const { expectedVersion, ...patch } = bodyObject(body);
            return this.definitions.update(user.id, id, positiveInteger(expectedVersion), patch);
        });
    }
    @Delete(':id') @HttpCode(204) remove(@CurrentUser() user: User, @Param('id') id: string, @Query('expectedVersion') version: string) {
        return http(async () => {
            await this.definitions.update(user.id, id, positiveInteger(version), {}, true);
        });
    }
}
@Controller('business-definition-candidates')
class CandidateController {
    constructor(private readonly definitions: Definitions) {}
    @Get() list(@CurrentUser() user: User, @Query('datasourceId') ds: string, @Query('conversationId') conversation?: string) {
        return http(() => this.definitions.candidates(user.id, positiveInteger(ds), conversation));
    }
    private decide(user: User, id: string, body: unknown, accept: boolean) {
        return http(() => {
            const b = bodyObject(body);
            if (Object.keys(b).some((k) => k !== 'expectedVersion')) throw new DefinitionError(400, '存在不允许的字段');
            return this.definitions.decide(user.id, id, positiveInteger(b.expectedVersion), accept);
        });
    }
    @Post(':id/confirm') confirm(@CurrentUser() user: User, @Param('id') id: string, @Body() body: unknown) {
        return this.decide(user, id, body, true);
    }
    @Post(':id/reject') reject(@CurrentUser() user: User, @Param('id') id: string, @Body() body: unknown) {
        return this.decide(user, id, body, false);
    }
}
@Module({ controllers: [DefinitionController, CandidateController], providers: [Definitions] })
export class BusinessDefinitionModule {}
