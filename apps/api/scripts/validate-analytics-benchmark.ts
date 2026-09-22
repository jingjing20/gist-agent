import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { DatabaseClient, type QueryRow } from '@gist/database';
import { loadWorkspaceEnv } from '@gist/config';

interface SqlCase {
    id: string;
    type: 'sql';
    category: string;
    difficulty: string;
    question: string;
    tables: string[];
    sql: string;
    expected: { columns: string[]; rows: QueryRow[] } | null;
    answer_notes: string[];
}

interface SemanticCase {
    id: string;
    type: 'semantic';
    category: string;
    difficulty: string;
    question: string;
    tables: string[];
    expected: { must_include_concepts: string[]; must_not_claim: string[] };
    answer_notes: string[];
}

interface Benchmark {
    version: number;
    dataset_key: string;
    anchor_date: string;
    description: string;
    evaluation: Record<string, number>;
    cases: Array<SqlCase | SemanticCase>;
}

const benchmarkPath = fileURLToPath(new URL('../../../benchmarks/saas-growth/cases.json', import.meta.url));
const answersPath = fileURLToPath(new URL('../../../benchmarks/saas-growth/answers.md', import.meta.url));
const referenceSqlPath = fileURLToPath(new URL('../../../benchmarks/saas-growth/reference.sql', import.meta.url));

function stableRows(rows: QueryRow[]): QueryRow[] {
    return JSON.parse(JSON.stringify(rows));
}

function markdownValue(value: unknown): string {
    if (value === null || value === undefined) return 'NULL';
    return String(value).replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function resultTable(expected: NonNullable<SqlCase['expected']>): string {
    if (expected.rows.length === 0) return '_结果为空_';
    const header = `| ${expected.columns.join(' | ')} |`;
    const separator = `| ${expected.columns.map(() => '---').join(' | ')} |`;
    const rows = expected.rows.map((row) => `| ${expected.columns.map((column) => markdownValue(row[column])).join(' | ')} |`);
    return [header, separator, ...rows].join('\n');
}

function renderAnswers(benchmark: Benchmark): string {
    const lines = [
        '# SaaS Growth Demo 常见问题与标准答案',
        '',
        '> 自动生成：来源为 [cases.json](./cases.json)，请勿直接修改结果。维护方式见 [README](./README.md)。',
        '',
        `- 数据集：\`${benchmark.dataset_key}\``,
        `- 固定数据日期：\`${benchmark.anchor_date}\``,
        `- 用例版本：\`${benchmark.version}\``,
        '',
        '> 标准答案用于核对口径和关键结果，不要求 Agent 使用完全相同的措辞或 SQL。金额单位均为人民币元，事件日期默认按 UTC 解释。',
        '',
    ];

    for (const testCase of benchmark.cases) {
        lines.push(
            `## ${testCase.id} · ${testCase.question}`,
            '',
            `- 分类：${testCase.category}`,
            `- 难度：${testCase.difficulty}`,
            `- 涉及表：${testCase.tables.length ? testCase.tables.map((table) => `\`${table}\``).join('、') : '无可用内部表'}`,
            ''
        );
        if (testCase.type === 'sql') {
            lines.push('标准结果：', '', resultTable(testCase.expected!), '', '<details>', '<summary>参考 SQL</summary>', '', '```sql', testCase.sql, '```', '', '</details>', '');
        } else {
            lines.push(
                '标准答案要点：',
                '',
                ...testCase.expected.must_include_concepts.map((concept) => `- ${concept}`),
                '',
                '不可接受的结论：',
                '',
                ...testCase.expected.must_not_claim.map((claim) => `- ${claim}`),
                ''
            );
        }
        if (testCase.answer_notes.length) lines.push('评分提示：', '', ...testCase.answer_notes.map((note) => `- ${note}`), '');
    }
    return `${lines.join('\n')}\n`;
}

function renderReferenceSql(benchmark: Benchmark): string {
    const lines = [`-- ${benchmark.description}`, `-- dataset=${benchmark.dataset_key}; anchor_date=${benchmark.anchor_date}; version=${benchmark.version}`, ''];
    for (const testCase of benchmark.cases) {
        if (testCase.type !== 'sql') continue;
        lines.push(`-- ${testCase.id} | ${testCase.category} | ${testCase.question}`, `${testCase.sql};`, '');
    }
    return `${lines.join('\n')}\n`;
}

async function main(): Promise<void> {
    loadWorkspaceEnv();
    const benchmark = JSON.parse(await readFile(benchmarkPath, 'utf8')) as Benchmark;
    const update = process.argv.includes('--update');
    const ids = new Set<string>();
    const totalWeight = Object.values(benchmark.evaluation).reduce((sum, weight) => sum + weight, 0);
    assert.equal(totalWeight, 100, 'evaluation weights must total 100');

    const db = new DatabaseClient();
    await db.connect();
    try {
        const catalogRows = await db.query<QueryRow[]>(
            `SELECT table_name FROM datasource_table_catalog
             WHERE dataset_key = ? AND is_agent_visible = TRUE
             ORDER BY table_name`,
            [benchmark.dataset_key]
        );
        assert.equal(catalogRows.length, 10, `expected 10 visible tables for ${benchmark.dataset_key}`);
        const removedTables = await db.query<QueryRow[]>(
            `SELECT table_name FROM information_schema.tables
             WHERE table_schema = current_schema()
               AND table_name IN ('platform_info','daily_active_stats','user_behavior_log')`
        );
        assert.deepEqual(removedTables, [], 'legacy demo tables must not coexist with this benchmark');

        for (const testCase of benchmark.cases) {
            assert.ok(!ids.has(testCase.id), `duplicate case id: ${testCase.id}`);
            ids.add(testCase.id);
            assert.ok(testCase.question.trim(), `${testCase.id} question is required`);
            assert.ok(testCase.answer_notes.length > 0, `${testCase.id} answer notes are required`);
            if (testCase.type === 'semantic') {
                assert.ok(testCase.expected.must_include_concepts.length > 0, `${testCase.id} needs required concepts`);
                assert.ok(testCase.expected.must_not_claim.length > 0, `${testCase.id} needs forbidden claims`);
                continue;
            }
            assert.match(testCase.sql.trim(), /^(SELECT|WITH)\b/i, `${testCase.id} must be read-only SQL`);
            const rows = stableRows(await db.query<QueryRow[]>(testCase.sql));
            const actual = { columns: rows.length ? Object.keys(rows[0]) : [], rows };
            if (update) testCase.expected = actual;
            else assert.deepEqual(actual, testCase.expected, `${testCase.id} result drifted; run benchmark:analytics:update only after reviewing the dataset change`);
        }

        if (update) {
            await writeFile(benchmarkPath, `${JSON.stringify(benchmark, null, 2)}\n`);
            await writeFile(answersPath, renderAnswers(benchmark));
            await writeFile(referenceSqlPath, renderReferenceSql(benchmark));
        }
    } finally {
        await db.close();
    }

    const sqlCases = benchmark.cases.filter((testCase) => testCase.type === 'sql').length;
    const semanticCases = benchmark.cases.length - sqlCases;
    console.log(`${update ? 'Updated' : 'Validated'} ${sqlCases} SQL cases and ${semanticCases} semantic cases.`);
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
