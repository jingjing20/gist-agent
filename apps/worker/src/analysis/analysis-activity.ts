import type { AnalysisActivityDetailV1, AnalysisActivityKind, AnalysisActivityMessageV1, AnalysisActivityV1, ResultQualitySeverity } from '@gist/contracts';

export interface ToolActivityData {
    executedSql?: string;
    sourceTables?: string[];
    sourceFields?: string[];
}

const definitions: Partial<Record<string, { kind: AnalysisActivityKind; label: string }>> = {
    update_analysis_state: { kind: 'confirm_conditions', label: '确认分析条件' },
    list_schema: { kind: 'inspect_catalog', label: '查看数据目录' },
    list_memories: { kind: 'inspect_memory', label: '查看记忆' },
    read_memory: { kind: 'inspect_memory', label: '读取记忆' },
    get_schema: { kind: 'inspect_schema', label: '读取表结构' },
    execute_sql_query: { kind: 'query_data', label: '查询数据' },
    generate_chart: { kind: 'generate_chart', label: '生成图表' },
};

function record(value: unknown): Record<string, any> {
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, any>) : {};
}

function text(value: unknown): string {
    return typeof value === 'string' ? value : value == null ? '' : String(value);
}

function detail(label: string, value: string | string[] | undefined): AnalysisActivityDetailV1 | undefined {
    if (Array.isArray(value)) return value.length ? { label, value } : undefined;
    return value ? { label, value } : undefined;
}

function compact(items: Array<AnalysisActivityDetailV1 | undefined>): AnalysisActivityDetailV1[] {
    return items.filter((item): item is AnalysisActivityDetailV1 => !!item);
}

function qualitySeverity(value: unknown): ResultQualitySeverity {
    return value === 'info' || value === 'warning' || value === 'blocking' ? value : 'warning';
}

function formatRange(value: unknown): string {
    const range = record(value);
    return range.start && range.endExclusive ? `${range.start} 至 ${range.endExclusive}（${range.timezone || '默认时区'}）` : '未设置';
}

function formatFilters(value: unknown): string {
    if (!Array.isArray(value) || !value.length) return '无';
    return value
        .map((item) => {
            const filter = record(item);
            const filterValue = Array.isArray(filter.value) ? filter.value.join('、') : text(filter.value);
            return `${text(filter.field)} ${text(filter.operator)} ${filterValue}`.trim();
        })
        .join('；');
}

export function startActivity(id: string, toolName: string, args: Record<string, unknown>, startedAt = new Date(), groupId = id): AnalysisActivityV1 | undefined {
    const definition = definitions[toolName];
    if (!definition) return undefined;
    const plan = record(args.plan);
    const subject =
        toolName === 'execute_sql_query'
            ? text(args.title)
            : toolName === 'get_schema'
              ? text(args.table)
              : toolName === 'generate_chart'
                ? text(args.title)
                : toolName === 'list_schema'
                  ? text(args.q)
                  : '';
    let details: AnalysisActivityDetailV1[] = [];
    if (toolName === 'execute_sql_query') {
        details = compact([detail('查询目的', text(plan.purpose)), detail('查询粒度', text(plan.expectedGrain))]);
    } else if (toolName === 'get_schema') {
        details = compact([detail('数据表', text(args.table))]);
    } else if (toolName === 'list_schema') {
        details = compact([detail('查找范围', text(args.q) || '全部授权数据表')]);
    } else if (toolName === 'update_analysis_state') {
        details = compact([detail('确认原因', text(args.reason))]);
    } else if (toolName === 'generate_chart') {
        const fields = Array.isArray(args.yFields) ? args.yFields.map((item) => text(record(item).label || record(item).field)).filter(Boolean) : [];
        details = compact([detail('图表类型', text(args.chartType)), detail('横轴字段', text(args.xField)), detail('数值字段', fields)]);
    }
    return {
        version: 1,
        id,
        groupId,
        kind: definition.kind,
        status: 'running',
        label: definition.label,
        ...(subject ? { subject } : {}),
        details,
        startedAt: startedAt.toISOString(),
    };
}

export function completeActivity(
    activity: AnalysisActivityV1,
    toolName: string,
    args: Record<string, unknown>,
    resultValue: unknown,
    activityData: ToolActivityData | undefined,
    completedAt = new Date()
): AnalysisActivityV1 {
    const data = record(resultValue);
    const state = record(data.state);
    const details = [...activity.details];
    if (toolName === 'update_analysis_state') {
        details.push(
            ...compact([
                detail('分析目标', text(state.question)),
                detail('时间范围', formatRange(state.timeRange)),
                detail('对比范围', state.comparisonRange ? formatRange(state.comparisonRange) : '无'),
                detail('筛选条件', formatFilters(state.filters)),
                detail('分析粒度', text(state.grain) || '未设置'),
                detail(
                    '使用记忆',
                    Array.isArray(state.memoryRefs)
                        ? state.memoryRefs.map((item: unknown) => `${text(record(item).id)} · v${text(record(item).version)}`).filter(Boolean)
                        : []
                ),
                detail('临时约定', Array.isArray(state.temporaryNotes) ? state.temporaryNotes.map((item: unknown) => text(record(item).name)).filter(Boolean) : []),
            ])
        );
    } else if (toolName === 'list_schema') {
        details.push(
            ...compact([
                detail('候选数据表', Array.isArray(data.tables) ? data.tables.map((item: unknown) => text(record(item).displayName || record(item).name)).filter(Boolean) : []),
            ])
        );
    } else if (toolName === 'get_schema') {
        const columns = Array.isArray(data.columns)
            ? data.columns.map((item: unknown) => {
                  const column = record(item);
                  return `${text(column.name)}${column.type ? ` · ${text(column.type)}` : ''}${column.description ? ` · ${text(column.description)}` : ''}`;
              })
            : [];
        details.push(
            ...compact([
                detail('本页字段数', `${columns.length}`),
                detail('完整字段列表', columns),
                detail('字段分页', data.nextOffset == null ? '已读取当前表全部字段' : `还有字段，下一页偏移 ${data.nextOffset}`),
            ])
        );
    } else if (toolName === 'list_memories') {
        details.push(...compact([detail('候选记忆', Array.isArray(data.items) ? data.items.map((item: unknown) => text(record(item).name)).filter(Boolean) : [])]));
    } else if (toolName === 'read_memory') {
        details.push(...compact([detail('定义名称', text(data.name)), detail('定义类型', text(data.type)), detail('版本', data.version == null ? undefined : `v${data.version}`)]));
    } else if (toolName === 'execute_sql_query') {
        details.push(
            ...compact([
                detail('数据来源', activityData?.sourceTables),
                detail('使用字段', activityData?.sourceFields),
                detail('返回结果', `${Number(data.returnedRowCount) || 0} 行`),
                detail('结果字段', Array.isArray(data.columns) ? data.columns.map((column: unknown) => text(record(column).name)).filter(Boolean) : []),
            ])
        );
    } else if (toolName === 'generate_chart') {
        const yFields = Array.isArray(args.yFields) ? args.yFields.map((item) => `${text(record(item).label)}（${text(record(item).field)}）`) : [];
        details.push(
            ...compact([
                detail('数值字段', yFields),
                detail('筛选条件', Array.isArray(args.filters) && args.filters.length ? JSON.stringify(args.filters) : '无'),
                detail('排序规则', Array.isArray(args.sort) && args.sort.length ? JSON.stringify(args.sort) : '无'),
            ])
        );
    }
    const durationMs = Math.max(0, completedAt.getTime() - new Date(activity.startedAt).getTime());
    const queryArtifactId = text(data.queryArtifactId);
    const originalSql = text(args.sql);
    const executedSql = activityData?.executedSql || originalSql;
    const qualityMessages: AnalysisActivityMessageV1[] = Array.isArray(record(data.resultQuality).warnings)
        ? record(data.resultQuality)
              .warnings.map((item: unknown) => {
                  const value = record(item);
                  return {
                      severity: qualitySeverity(value.severity),
                      message: text(value.message),
                      ...(text(value.action) ? { action: text(value.action) } : {}),
                  };
              })
              .filter((item: AnalysisActivityMessageV1) => !!item.message)
        : [];
    const warningMessages = qualityMessages.filter((item) => item.severity !== 'info');
    return {
        ...activity,
        status: warningMessages.length ? 'warning' : 'completed',
        details: dedupeDetails(details),
        completedAt: completedAt.toISOString(),
        durationMs,
        ...(qualityMessages.length ? { qualityMessages } : {}),
        ...(warningMessages.length ? { warning: warningMessages.map((item) => item.message).join('；') } : {}),
        ...(toolName === 'execute_sql_query' && queryArtifactId
            ? {
                  query: {
                      artifactId: queryArtifactId,
                      originalSql,
                      executedSql,
                      adjusted: normalizeSql(originalSql) !== normalizeSql(executedSql),
                      rowCount: Number(data.returnedRowCount) || 0,
                      isLimited: data.isLimited === true,
                  },
              }
            : {}),
    };
}

function dedupeDetails(details: AnalysisActivityDetailV1[]): AnalysisActivityDetailV1[] {
    const byLabel = new Map<string, AnalysisActivityDetailV1>();
    for (const item of details) byLabel.set(item.label, item);
    return [...byLabel.values()];
}

function normalizeSql(sql: string): string {
    return sql.replace(/\s+/g, ' ').trim().replace(/;$/, '').toLowerCase();
}
