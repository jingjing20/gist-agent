import type { ArtifactColumnV1, QueryPlanV1, ResultQualityV1, ResultQualityWarningV1 } from '@gist/contracts';

export function assessResultQuality(input: {
    plan: QueryPlanV1;
    sql: string;
    columns: ArtifactColumnV1[];
    rows: Record<string, unknown>[];
    isLimited: boolean;
    toolResultTruncated?: boolean;
}): ResultQualityV1 {
    const warnings: ResultQualityWarningV1[] = [];
    const rowCount = input.rows.length;
    const nullRates: Record<string, number> = {};
    for (const column of input.columns) {
        const nulls = input.rows.filter((row) => row[column.name] == null).length;
        nullRates[column.name] = rowCount === 0 ? 0 : Number((nulls / rowCount).toFixed(4));
        if (nulls > 0)
            warnings.push(warning('NULL_VALUES', 'warning', `字段 ${column.name} 含 ${nulls}/${rowCount} 个空值`, '解释指标时说明空值处理方式，必要时追加过滤或完整性查询'));
    }
    if (rowCount === 0) warnings.push(warning('EMPTY_RESULT', 'warning', '查询没有返回记录', '不得将空结果直接解释为业务指标为零；检查过滤条件、数据完整性和字段口径'));
    if (input.isLimited) warnings.push(warning('RESULT_LIMITED', 'blocking', '结果达到查询返回上限，可能只是样本', '禁止据此推断全集分布、排名或总量；必须追加聚合或计数查询'));
    if (input.toolResultTruncated) warnings.push(warning('TOOL_RESULT_TRUNCATED', 'blocking', '模型只收到部分结果行', '禁止基于展示子集推断全集；使用 Artifact 或追加聚合查询'));
    if (/\bjoin\b/i.test(input.sql))
        warnings.push(
            warning('JOIN_FANOUT_RISK', 'warning', '查询包含 JOIN，存在粒度放大风险', `核对 JOIN 键与预期粒度“${input.plan.expectedGrain}”，必要时比较 JOIN 前后行数或唯一键数`)
        );

    const grainColumns = inferGrainColumns(input.plan.expectedGrain, input.columns);
    let duplicateKeyCount: number | undefined;
    if (grainColumns.length) {
        const keys = input.rows.map((row) => grainColumns.map((column) => stableValue(row[column])).join('\u001f'));
        duplicateKeyCount = keys.length - new Set(keys).size;
        if (duplicateKeyCount > 0)
            warnings.push(
                warning('DUPLICATE_GRAIN', 'blocking', `按预期粒度字段 ${grainColumns.join(', ')} 检测到 ${duplicateKeyCount} 条重复`, '不得直接汇总；先修正 JOIN 或聚合粒度')
            );
    }

    const dateColumn = input.columns.find((column) => column.type === 'date');
    let timeRange: ResultQualityV1['timeRange'];
    if (dateColumn) {
        const values = input.rows.map((row) => row[dateColumn.name]).filter((value): value is string => typeof value === 'string' && !Number.isNaN(Date.parse(value)));
        if (values.length) {
            const sorted = values.map((value) => new Date(value).toISOString()).sort();
            timeRange = { column: dateColumn.name, min: sorted[0], max: sorted[sorted.length - 1], timezone: 'UTC' };
            warnings.push(
                warning(
                    'TIMEZONE_ASSUMED',
                    'info',
                    `时间范围按 UTC 解释：${formatUtcDateTime(timeRange.min)} 至 ${formatUtcDateTime(timeRange.max)}`,
                    '若业务时区不是 UTC，结论中必须声明并使用显式时区重查'
                )
            );
        }
    }

    return {
        expectedGrain: input.plan.expectedGrain,
        expectedShape: input.plan.expectedShape,
        observedRowCount: rowCount,
        isLimited: input.isLimited,
        toolResultTruncated: input.toolResultTruncated === true,
        nullRates,
        ...(duplicateKeyCount === undefined ? {} : { duplicateKeyCount }),
        ...(timeRange ? { timeRange } : {}),
        warnings: deduplicateWarnings(warnings),
    };
}

function formatUtcDateTime(value: string): string {
    return value.replace('T', ' ').replace(/\.\d{3}Z$/, '');
}

function inferGrainColumns(expectedGrain: string, columns: ArtifactColumnV1[]): string[] {
    const normalized = expectedGrain.toLowerCase();
    return columns.map((column) => column.name).filter((name) => normalized.includes(name.toLowerCase()));
}

function stableValue(value: unknown): string {
    if (value instanceof Date) return value.toISOString();
    return JSON.stringify(value) ?? String(value);
}

function warning(code: ResultQualityWarningV1['code'], severity: ResultQualityWarningV1['severity'], message: string, action: string): ResultQualityWarningV1 {
    return { code, severity, message, action };
}

function deduplicateWarnings(warnings: ResultQualityWarningV1[]): ResultQualityWarningV1[] {
    const seen = new Set<string>();
    return warnings.filter((item) => {
        const key = `${item.code}:${item.message}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}
