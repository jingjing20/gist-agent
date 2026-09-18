import { Controller, Get, NotFoundException, Param, Query } from '@nestjs/common';
import { CurrentUser } from '../auth/user.decorator';
import type { User } from '../auth/auth.service';
import { OperationsService } from './operations.service';

@Controller('operations')
export class OperationsController {
    constructor(private readonly operations: OperationsService) {}

    @Get('dashboard')
    dashboard(@CurrentUser() user: User, @Query('days') days?: string) {
        return this.operations.dashboard(user.id, Number(days) || 7);
    }

    @Get('generations/:id/trace')
    async trace(@CurrentUser() user: User, @Param('id') id: string) {
        const trace = await this.operations.trace(user.id, id);
        if (!trace) throw new NotFoundException('生成任务不存在');
        return { generationId: id, spans: trace };
    }
}
