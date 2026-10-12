/** Public action descriptions, never inferred findings or internal state changes. */
export function actionNarrative(tool: string, args: Record<string, unknown>, chinese: boolean): string | undefined {
    const descriptions: Record<string, [string, string]> = {
        list_schema: ['我先查看数据目录，找到与问题相关的数据表。', 'I will check the data catalog for the relevant tables.'],
        get_schema: ['我会读取相关表结构，核对分析需要的字段。', 'I will read the table structure and check the fields needed for this analysis.'],
        list_memories: ['我先核对已保存的业务口径。', 'I will check the saved business definitions.'],
        read_memory: ['我会读取相关业务定义，确认统计口径。', 'I will read the relevant business definitions to confirm how the metrics are measured.'],
        execute_sql_query: ['我会查询所需数据，核对本轮分析的结果。', 'I will query the data needed for this analysis.'],
        read_query_artifact: ['我会回读已有查询结果，核对是否适用于本次分析。', 'I will read the existing query evidence and check whether it applies to this analysis.'],
        generate_chart: ['我会把查询结果整理成图表，方便查看和比较。', 'I will turn the query results into a chart for comparison.'],
        display_query_table: ['我会展示查询结果，方便核对具体数值。', 'I will display the query results so the exact values can be checked.'],
    };
    const description = descriptions[tool]?.[chinese ? 0 : 1];
    if (tool !== 'execute_sql_query' || !chinese || typeof args.title !== 'string') return description;
    // Tool titles are data. Keep them short and literal; never print raw SQL.
    const title = args.title.replace(/\s+/g, ' ').trim().slice(0, 80);
    if (!title || /\b(?:select|insert|update|delete|cast|sql)\b/i.test(title)) return description;
    const literal = title.replace(/[\\`*_[\]<>]/g, '\\$&');
    return `我会查询「${literal}」，获取本轮分析所需的数据。`;
}
