import { Module } from '@nestjs/common';
import { DataSourceController } from './datasource.controller';
import { DataSourceService } from './datasource.service';
import { SuggestionService } from './suggestion.service';

@Module({
	controllers: [DataSourceController],
	providers: [DataSourceService, SuggestionService],
	exports: [DataSourceService, SuggestionService],
})
export class DataSourceModule { }
