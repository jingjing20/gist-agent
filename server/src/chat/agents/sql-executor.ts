import { Injectable, Logger } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { LlmService } from '../../llm/llm.service';
import { RowDataPacket } from 'mysql2/promise';

const MAX_ROWS = 1000;

export interface QueryResult {
	finalSql: string;
	wasFixed: boolean;
	columns: string[];
	rows: Record<string, unknown>[];
	rowCount: number;
}

@Injectable()
export class SqlExecutorAgent {
	private readonly logger = new Logger(SqlExecutorAgent.name);

	constructor(
		private readonly db: DatabaseService,
		private readonly llm: LlmService,
	) { }

	private async queryWithTimeout<T>(
		sql: string,
		datasourceId?: number | null,
		timeoutMs = 15000
	): Promise<T> {
		return Promise.race([
			this.db.query<T extends RowDataPacket[] ? T : any>(sql, [], datasourceId),
			new Promise<T>((_, reject) =>
				setTimeout(() => reject(new Error(`查询超时（> ${timeoutMs / 1000}s），已自动熔断拦截`)), timeoutMs)
			)
		]);
	}

	private readonly FORBIDDEN_KEYWORDS = [
		'INSERT', 'UPDATE', 'DELETE', 'DROP', 'ALTER',
		'CREATE', 'TRUNCATE', 'GRANT', 'REVOKE', 'REPLACE',
		'SET', 'CALL', 'LOCK', 'UNLOCK',
	];

	validate(sql: string): void {
		for (const keyword of this.FORBIDDEN_KEYWORDS) {
			const pattern = new RegExp(`\\b${keyword}\\b`, 'i');
			if (pattern.test(sql)) {
				throw new Error(`SQL 包含禁止的操作: ${keyword}`);
			}
		}
		if (/\bLOAD\s+DATA\b/i.test(sql)) {
			throw new Error('SQL 包含禁止的操作: LOAD DATA');
		}
	}

	ensureLimit(sql: string): string {
		const normalized = sql.trim().toUpperCase();
		if (!normalized.includes('LIMIT')) {
			return `${sql.replace(/;\s*$/, '')} LIMIT ${MAX_ROWS}`;
		}
		return sql;
	}

	private isSelectLike(sql: string): boolean {
		const normalized = sql.trim().toUpperCase();
		return normalized.startsWith('SELECT') || normalized.startsWith('WITH ');
	}

	private isSyntaxError(error: any): boolean {
		if (!error || typeof error !== 'object') return false;

		// 核心原则：只拦截且只修复纯粹的“语法层面（Syntax/Dialect）”错误。
		// 严禁拦截语义层面（Semantic）错误，如 ER_NO_SUCH_TABLE, ER_BAD_FIELD_ERROR
		// 因为这些需要全量 Schema 上下文，强行修复会导致胡乱猜测字段，引发数据错误灾难。
		const syntaxErrorCodes = [
			'ER_PARSE_ERROR', // 1064 语法错误
			'ER_WRONG_FIELD_WITH_GROUP', // 1055 ONLY_FULL_GROUP_BY 限制
			'ER_MIX_OF_GROUP_FUNC_AND_FIELDS', // 1140 聚合与非聚合混用
			'ER_TOO_MANY_TABLES', // 连接太多表
			'ER_NON_UNIQ_ERROR', // 模糊的列引用
		];

		return error.code && syntaxErrorCodes.includes(error.code);
	}

	private async attemptFixSql(originalSql: string, errorMessage: string): Promise<string> {
		const systemPrompt = `你是一个顶尖的 MySQL 数据分析工程师。你的任务是修复一段报错的 SQL 语句。` +
			`由于你是在一个自动拦截防腐层内运行，你的上下文中没有完整的数据库 Schema。` +
			`因此，你 **绝不能** 随意猜测或编造表名、字段名，你只能仅就 SQL 的**语法层面**进行修复（例如修改 GROUP BY、修复标点符号、处理严格模式等）。\n\n` +
			`你 **必须且只能** 返回修复后的并且可以直接在 MySQL 8.0 运行的纯 SQL 代码。\n` +
			`不要返回任何 markdown 格式（例如 \`\`\`sql），不要加任何解释，不要包含多余的话语。`;

		const userPrompt = `原始 SQL:\n${originalSql}\n\nMySQL 报错信息:\n${errorMessage}`;

		const response = await this.llm.chat(systemPrompt, userPrompt, 0);
		// 清理可能的 markdown 后缀
		let cleanSql = response.replace(/```sql/i, '').replace(/```/g, '').trim();
		// 如果小模型还是习惯性地返回了包含 SELECT 之外的不相干文字，通过正则进一步保护
		return cleanSql;
	}

	async execute(sql: string, datasourceId?: number | null): Promise<QueryResult> {
		const maxRetries = 2;
		let currentSql = sql;
		let attempt = 0;

		while (attempt <= maxRetries) {
			try {
				this.validate(currentSql);
				const safeSql = this.isSelectLike(currentSql) ? this.ensureLimit(currentSql) : currentSql;

				const rows = await this.queryWithTimeout<RowDataPacket[]>(safeSql, datasourceId, 15000);
				const columns = rows.length > 0 ? Object.keys(rows[0]) : [];

				return {
					finalSql: safeSql,
					wasFixed: currentSql !== sql,
					columns,
					rows: rows as Record<string, unknown>[],
					rowCount: rows.length,
				};
			} catch (error: any) {
				attempt++;

				if (this.isSyntaxError(error) && attempt <= maxRetries) {
					this.logger.warn(`检测到 SQL 语法错误 (${error.code})，正在启动内部小模型尝试修复 (第 ${attempt} 次尝试)...`);
					try {
						currentSql = await this.attemptFixSql(currentSql, error.message);
						this.logger.log(`小模型自动修复完成，重试新 SQL: ${currentSql}`);
						continue; // 进入下一次重试循环
					} catch (fixError: any) {
						this.logger.error(`小模型修复 SQL 失败: ${fixError.message}`);
						throw error; // 如果修复过程本身报错（比如调 LLM 失败），依然抛出原始的 SQL 错误
					}
				}

				// 1. 如果不是语法错误（比如表不存在，即语义错误）
				// 2. 或者已经达到了最大重试次数
				// 就直接向上一层大模型报错，绝不含糊
				this.logger.error(`SQL 执行异常，暴露错误给上层: ${error.message}`);
				throw error;
			}
		}

		throw new Error('超出最大 SQL 执行重试限制');
	}
}
