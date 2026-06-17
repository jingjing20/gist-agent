import { Injectable, Logger } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { LlmService } from '../llm/llm.service';

@Injectable()
export class SchemaEnrichmentService {
    private readonly logger = new Logger(SchemaEnrichmentService.name);

    constructor(
        private readonly db: DatabaseService,
        private readonly llm: LlmService
    ) {}

    async enrichTableSchemaAsync(tableName: string): Promise<void> {
        this.enrichTableSchema(tableName).catch((err) => {
            this.logger.error(`Async enrichment failed for ${tableName}: ${err.message}`);
        });
    }

    private async enrichTableSchema(tableName: string): Promise<void> {
        try {
            // 1. 获取表的现存字段信息
            const cols = await this.db.query<any[]>(
                `SELECT COLUMN_NAME, COLUMN_TYPE, COLUMN_COMMENT 
				 FROM information_schema.COLUMNS 
				 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
				 ORDER BY ORDINAL_POSITION`,
                [tableName]
            );

            if (!cols.length) return;

            // 2. 抽取少许样本数据
            const samples = await this.db.query<any[]>(`SELECT * FROM \`${tableName}\` LIMIT 5`);

            // 如果没数据，没法做样例级增强
            if (!samples.length) return;

            // 3. 构建 Prompt 交给 LLM 推导
            const systemPrompt = `你是一个资深的数据架构师。你的任务是根据给定的表结构和真实数据样本，推导并增强各个字段的业务注释。
要求：
- 注意推导分类字段的可能取值、时间字段的格式、数字字段的可能业务含义（例如金额单位、数量等）。
- 结合原有注释、字段名和数据样例，给出一个精炼且带更多语义信息的注释（适合未来给大模型生成 SQL 时参考阅读）。
- 只返回严格的 JSON 数组，格式必须为 [{"column": "原字段名", "comment": "丰富增强后的注释(如果原注释好则保留+补充)"}]。
- 没有解释，只有 JSON。`;

            const userPrompt = `表（${tableName}）结构：
${cols.map((c) => `- ${c.COLUMN_NAME} (${c.COLUMN_TYPE}): ${c.COLUMN_COMMENT || ''}`).join('\n')}

前 5 条真实数据样本：
${JSON.stringify(samples, null, 2)}`;

            const response = await this.llm.chat(systemPrompt, userPrompt, 0);
            const match = response.match(/\[[\s\S]*\]/);
            if (!match) throw new Error('LLM did not return a JSON array');

            const enrichments = JSON.parse(match[0]);

            // 4. 回写 MySQL
            for (const e of enrichments) {
                const col = cols.find((c) => c.COLUMN_NAME === e.column);
                if (!col) continue;
                // 长度限制
                const newComment = String(e.comment).slice(0, 1000);
                const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

                await this.db.execute(`ALTER TABLE \`${tableName}\` MODIFY \`${col.COLUMN_NAME}\` ${col.COLUMN_TYPE} COMMENT '${esc(newComment)}'`);
            }

            this.logger.log(`Table [${tableName}] schema enrichment completed successfully.`);
        } catch (error: any) {
            this.logger.warn(`Failed to enrich schema for table [${tableName}]: ${error.message}`);
        }
    }
}
