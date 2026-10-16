/** Validate the columns used by the application without assuming IF NOT EXISTS upgrades an old table. */
export async function assertSchemaColumns(db: { query(sql: string): Promise<unknown> }, ddl: string): Promise<void> {
    const expected = new Map<string, Map<string, string>>();
    const tables = /CREATE TABLE IF NOT EXISTS\s+(\w+)\s*\(/gi;
    const types: Record<string, string> = {
        INTEGER: 'int4',
        INT: 'int4',
        BIGINT: 'int8',
        SMALLINT: 'int2',
        VARCHAR: 'varchar',
        TEXT: 'text',
        UUID: 'uuid',
        JSONB: 'jsonb',
        BOOLEAN: 'bool',
        TIMESTAMPTZ: 'timestamptz',
        NUMERIC: 'numeric',
    };
    for (const match of ddl.matchAll(tables)) {
        let index = match.index! + match[0].length,
            depth = 1,
            quote = '',
            part = '';
        const declarations: string[] = [];
        while (index < ddl.length && depth) {
            const char = ddl[index++];
            if (quote) {
                part += char;
                if (char === quote) {
                    if (ddl[index] === quote) part += ddl[index++];
                    else quote = '';
                }
            } else if (char === "'" || char === '"') {
                quote = char;
                part += char;
            } else if (char === '(') {
                depth++;
                part += char;
            } else if (char === ')') {
                depth--;
                if (depth) part += char;
            } else if (char === ',' && depth === 1) {
                declarations.push(part);
                part = '';
            } else part += char;
        }
        declarations.push(part);
        const columns = new Map<string, string>();
        for (const declaration of declarations) {
            const column = declaration.trim().match(/^(?:"([^"]+)"|(\w+))\s+(\w+)/);
            if (column && types[column[3].toUpperCase()]) columns.set(column[1] || column[2], types[column[3].toUpperCase()]);
        }
        expected.set(match[1], columns);
    }
    const result: any = await db.query('SELECT table_name,column_name,udt_name FROM information_schema.columns WHERE table_schema=current_schema()');
    const rows: Array<{ table_name: string; column_name: string; udt_name: string }> = Array.isArray(result) ? (Array.isArray(result[0]) ? result[0] : result) : result.rows;
    const actual = new Map(rows.map((row) => [`${row.table_name}.${row.column_name}`, row.udt_name]));
    const invalid: string[] = [];
    for (const [table, columns] of expected)
        for (const [column, type] of columns) {
            if (actual.get(`${table}.${column}`) !== type) invalid.push(`${table}.${column} (${type})`);
        }
    if (invalid.length) throw new Error(`数据库结构与当前代码不匹配，请运行当前迁移或显式重建开发库: ${invalid.join(', ')}`);
}
