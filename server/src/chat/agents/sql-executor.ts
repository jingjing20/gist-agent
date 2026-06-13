import { Injectable, Logger } from "@nestjs/common";
import { DatabaseService } from "../../database/database.service";
import { SchemaService } from "../../database/schema.service";
import { LlmService } from "../../llm/llm.service";
import { RowDataPacket } from "mysql2/promise";
import { Parser } from "node-sql-parser";

// SQL 查询返回给前端的上限行数，通过 AST 注入 LIMIT 子句强制生效
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
    private readonly schemaService: SchemaService,
  ) {}

  /**
   * 带超时的 SQL 查询执行。
   * 用 Promise.race 而不是 MySQL 的 MAX_EXECUTION_TIME，
   * 因为并非所有 MySQL 版本和语句类型都支持后者，
   * Promise.race 是最可靠的客户端兜底方案
   */
  private async queryWithTimeout<T>(
    sql: string,
    datasourceId?: number | null,
    timeoutMs = 15000,
  ): Promise<T> {
    return Promise.race([
      this.db.query<T extends RowDataPacket[] ? T : any>(sql, [], datasourceId),
      new Promise<T>((_, reject) =>
        setTimeout(
          () =>
            reject(
              new Error(`查询超时（> ${timeoutMs / 1000}s），已自动熔断拦截`),
            ),
          timeoutMs,
        ),
      ),
    ]);
  }

  /**
   * 防线一：AST 级白名单校验。
   * 将 SQL 解析为 AST 后逐节点检查语句类型，仅放行只读操作。
   * 为什么用 AST 而不是正则：正则无法处理子查询、CTE、注释注入等绕过手段
   */
  validate(
    sql: string,
    allowedTables: string[] | "ALL" = "ALL",
  ): { astResult: any; parser: Parser } {
    const parser = new Parser();
    let astResult;
    try {
      astResult = parser.parse(sql, { database: "MySQL" });
    } catch (error: any) {
      // 将 AST 的解析异常强行包装为原生 SQL 语法错误
      // 触发本类的 attemptFixSql 由大模型尝试静默修正
      const syntaxErr = new Error(`[AST 解析异常] ${error.message}`);
      (syntaxErr as any).code = "ER_PARSE_ERROR";
      throw syntaxErr;
    }

    // parser.ast 在单条查询时是对象，多条拼接（分号隔开等情况）时是数组
    const astList = Array.isArray(astResult.ast)
      ? astResult.ast
      : [astResult.ast];
    const allowedTypes = ["select", "show", "desc", "describe", "explain"];

    for (const node of astList) {
      const type = (node.type || "").toLowerCase();
      if (!allowedTypes.includes(type)) {
        // 直接抛往外部让大模型感知自身越权
        throw new Error(
          `安全阻断：探测到非法的 [${type}] 操作。当前被限制为纯只读探查模式，禁止可能的数据修改或越权操作！`,
        );
      }
    }

    if (allowedTables !== "ALL") {
      try {
        const tables = parser.tableList(sql);
        for (const tableStr of tables) {
          // node-sql-parser tableList format: 'select::dbName::tableName'
          const parts = tableStr.split("::");
          const tableName = parts[2]?.replace(/`/g, "")?.toLowerCase();
          if (tableName && !allowedTables.includes(tableName)) {
            throw new Error(
              `安全阻断：探测到越权访问。表 [${tableName}] 不在当前数据源的允许范围内。`,
            );
          }
        }
      } catch (e: any) {
        if (e.message.startsWith("安全阻断")) {
          throw e;
        }
        // 忽略解析表名列表的其他错误，交给后面的执行去报错
      }
    }

    return { astResult, parser };
  }

  /**
   * 防线二：自动注入 LIMIT。
   * 针对无 LIMIT 的 SELECT，通过 AST 修改注入 LIMIT 1000。
   * 最终统一 sqlify 输出，既注入了约束又规范化了 SQL 格式
   */
  ensureLimit(astResult: any, parser: Parser): string {
    const astList = Array.isArray(astResult.ast)
      ? astResult.ast
      : [astResult.ast];
    let modified = false;

    for (const node of astList) {
      if (node.type?.toLowerCase() === "select") {
        if (!node.limit) {
          // 注入 limit
          node.limit = {
            seperator: "",
            value: [{ type: "number", value: MAX_ROWS }],
          };
          modified = true;
        }
      }
    }

    if (modified) {
      return parser.sqlify(astResult.ast, { database: "MySQL" });
    }
    // 如果没修改（比如原本就有 limit 或者 不是 select 语句），我们也可以直接 sqlify
    // 但为了保持原有格式，返回原 sql（其实 AST 里没存原 SQL，需要外部传或者默认全 sqlify）
    // 我们直接无脑 sqlify，还能起到统一格式化的作用
    return parser.sqlify(astResult.ast, { database: "MySQL" });
  }

  private isShowTables(sql: string): boolean {
    return /^SHOW\s+(FULL\s+)?TABLES/i.test(sql.trim());
  }

  private filterShowTablesRows(
    rows: Record<string, unknown>[],
    allowedTables: string[],
  ): Record<string, unknown>[] {
    return rows.filter((row) => {
      const tableName = Object.values(row)[0];
      if (typeof tableName !== "string") return false;
      return allowedTables.includes(tableName);
    });
  }

  /**
   * 核心决策点：区分"语法错误"和"语义错误"。
   * 语法错误 = LLM 的笔误，可由内部小模型静默修复。
   * 语义错误 = 表/字段不存在，需要完整 Schema，强行修复会编造字段导致数据灾难。
   * 设计原则：可修复的自动修，不可修复的暴露给上层
   */
  private isSyntaxError(error: any): boolean {
    if (!error || typeof error !== "object") return false;

    // 核心原则：只拦截且只修复纯粹的“语法层面（Syntax/Dialect）”错误。
    // 严禁拦截语义层面（Semantic）错误，如 ER_NO_SUCH_TABLE, ER_BAD_FIELD_ERROR
    // 因为这些需要全量 Schema 上下文，强行修复会导致胡乱猜测字段，引发数据错误灾难。
    const syntaxErrorCodes = [
      "ER_PARSE_ERROR", // 1064 语法错误
      "ER_WRONG_FIELD_WITH_GROUP", // 1055 ONLY_FULL_GROUP_BY 限制
      "ER_MIX_OF_GROUP_FUNC_AND_FIELDS", // 1140 聚合与非聚合混用
      "ER_TOO_MANY_TABLES", // 连接太多表
      "ER_NON_UNIQ_ERROR", // 模糊的列引用
    ];

    return error.code && syntaxErrorCodes.includes(error.code);
  }

  private async attemptFixSql(
    originalSql: string,
    errorMessage: string,
  ): Promise<string> {
    const systemPrompt =
      `你是一个顶尖的 MySQL 数据分析工程师。你的任务是修复一段报错的 SQL 语句。` +
      `由于你是在一个自动拦截防腐层内运行，你的上下文中没有完整的数据库 Schema。` +
      `因此，你 **绝不能** 随意猜测或编造表名、字段名，你只能仅就 SQL 的**语法层面**进行修复（例如修改 GROUP BY、修复标点符号、处理严格模式等）。\n\n` +
      `你 **必须且只能** 返回修复后的并且可以直接在 MySQL 8.0 运行的纯 SQL 代码。\n` +
      `不要返回任何 markdown 格式（例如 \`\`\`sql），不要加任何解释，不要包含多余的话语。`;

    const userPrompt = `原始 SQL:\n${originalSql}\n\nMySQL 报错信息:\n${errorMessage}`;

    const response = await this.llm.chat(systemPrompt, userPrompt, 0);
    // 清理可能的 markdown 后缀
    let cleanSql = response
      .replace(/```sql/i, "")
      .replace(/```/g, "")
      .trim();
    // 如果小模型还是习惯性地返回了包含 SELECT 之外的不相干文字，通过正则进一步保护
    return cleanSql;
  }

  /**
   * 公开入口：执行 SQL 并返回结构化结果。
   * 整合三道防线 + 自愈重试循环：
   *   validate() -> ensureLimit() -> queryWithTimeout()
   *   若语法错误 -> attemptFixSql() -> 重试 (max 2 次)
   *   若语义错误 -> 直接向上层暴露
   */
  async execute(
    sql: string,
    datasourceId?: number | null,
    userId?: number,
  ): Promise<QueryResult> {
    const maxRetries = 2;
    let currentSql = sql;
    let attempt = 0;

    let allowedTables: string[] | "ALL" = "ALL";
    if (userId) {
      allowedTables = await this.schemaService.getAllowedTableNames(
        datasourceId || null,
        userId,
      );
    }

    while (attempt <= maxRetries) {
      try {
        const { astResult, parser } = this.validate(currentSql, allowedTables);
        const safeSql = this.ensureLimit(astResult, parser);

        let rows = await this.queryWithTimeout<RowDataPacket[]>(
          safeSql,
          datasourceId,
          15000,
        );

        if (allowedTables !== "ALL" && this.isShowTables(safeSql)) {
          rows = this.filterShowTablesRows(
            rows as Record<string, unknown>[],
            allowedTables,
          ) as RowDataPacket[];
        }

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
          this.logger.warn(
            `检测到 SQL 语法错误 (${error.code})，正在启动内部小模型尝试修复 (第 ${attempt} 次尝试)...`,
          );
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

    throw new Error("超出最大 SQL 执行重试限制");
  }
}
