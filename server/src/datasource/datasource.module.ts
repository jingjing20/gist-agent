import { Module } from '@nestjs/common';
import { DataSourceController } from './datasource.controller';
import { DataSourceService } from './datasource.service';
import { SuggestionService } from './suggestion.service';
import { SchemaEnrichmentService } from './schema-enrichment.service';

@Module({
	controllers: [DataSourceController],
	providers: [DataSourceService, SuggestionService, SchemaEnrichmentService],
	exports: [DataSourceService, SuggestionService, SchemaEnrichmentService],
})
export class DataSourceModule { }
