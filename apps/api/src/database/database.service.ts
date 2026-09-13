import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DatabaseClient } from '@gist/database';

/** API 的 NestJS 数据库适配器；连接与事务实现位于共享数据库包。 */
@Injectable()
export class DatabaseService extends DatabaseClient implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(DatabaseService.name);
    async onModuleInit(): Promise<void> { await this.connect(); this.logger.log('PostgreSQL connection ready'); }
    async onModuleDestroy(): Promise<void> { await this.close(); }
}

export type { QueryRow, ExecuteResult, TransactionConnection } from '@gist/database';
