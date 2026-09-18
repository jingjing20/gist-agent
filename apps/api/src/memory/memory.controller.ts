import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { CurrentUser } from '../auth/user.decorator';
import type { User } from '../auth/auth.service';
import { MemoryService } from './memory.service';

@Controller('memories')
export class MemoryController {
    constructor(private readonly memories: MemoryService) {}
    @Get() list(@CurrentUser() user: User) { return this.memories.list(user.id); }
    @Post(':id/confirm') confirm(@CurrentUser() user: User, @Param('id') id: string, @Body() body: { expectedVersion: number }) {
        return this.memories.confirm(id, user.id, body.expectedVersion);
    }
    @Patch(':id') correct(@CurrentUser() user: User, @Param('id') id: string, @Body() body: { expectedVersion: number; value: Record<string, unknown> }) {
        return this.memories.correct(id, user.id, body.expectedVersion, body.value);
    }
    @Delete(':id') forget(@CurrentUser() user: User, @Param('id') id: string, @Body() body: { expectedVersion: number }) {
        return this.memories.forget(id, user.id, body.expectedVersion);
    }
}
