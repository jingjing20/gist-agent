import { Module, Global } from '@nestjs/common';
import { DatabaseService } from './database.service';
import { SchemaService } from './schema.service';

@Global()
@Module({
    providers: [DatabaseService, SchemaService],
    exports: [DatabaseService, SchemaService],
})
export class DatabaseModule {}
