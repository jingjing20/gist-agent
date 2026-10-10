export * from './analysis';
export const GENERATION_QUEUE_NAME = 'conversation-generations';

export const GENERATION_ERROR_CODES = [
    'ANALYSIS_TIMEOUT',
    'CANCELLED',
    'WRITER_OWNERSHIP_LOST',
    'GENERATION_CAPACITY_UNAVAILABLE',
    'EMPTY_LLM_RESPONSE',
    'RESPONSE_LANGUAGE_MISMATCH',
    'CONTEXT_BUDGET_EXCEEDED',
    'ANALYSIS_PROTOCOL_ERROR',
    'ANALYSIS_NO_PROGRESS',
    'MAX_AGENT_ITERATIONS_EXCEEDED',
    'LLM_REQUEST_FAILED',
    'TOOL_EXECUTION_FAILED',
    'INVALID_TOOL_ARGUMENTS',
    'INVALID_STATE_TRANSITION',
    'ARTIFACT_RESULT_TOO_LARGE',
    'ARTIFACT_NOT_FOUND',
    'ARTIFACT_ACCESS_DENIED',
    'ARTIFACT_FIELD_INVALID',
    'SQL_SECURITY_REJECTED',
    'SQL_VALIDATION_FAILED',
    'DATASOURCE_ACCESS_CHANGED',
    'WORKER_LOST',
    'INTERNAL_ERROR',
] as const;

export type GenerationErrorCode = (typeof GENERATION_ERROR_CODES)[number];

export type GenerationStatus = 'pending' | 'starting' | 'running' | 'completed' | 'failed' | 'cancel_requested' | 'cancelled';

export type QueryExpectedShape = 'scalar' | 'timeseries' | 'category' | 'detail';
export type ArtifactColumnType = 'number' | 'string' | 'date' | 'boolean' | 'unknown';
export type ChartType = 'line' | 'bar' | 'pie' | 'scatter' | 'radar' | 'funnel';

export type AnalysisActivityKind = 'confirm_conditions' | 'inspect_catalog' | 'inspect_memory' | 'inspect_schema' | 'query_data' | 'inspect_evidence' | 'generate_chart';
export type AnalysisActivityStatus = 'running' | 'completed' | 'warning';
export interface AnalysisActivityDetailV1 {
    label: string;
    value: string | string[];
}
export interface AnalysisActivityMessageV1 {
    severity: ResultQualitySeverity;
    message: string;
    action?: string;
}
export interface AnalysisActivityV1 {
    version: 1;
    id: string;
    groupId: string;
    kind: AnalysisActivityKind;
    status: AnalysisActivityStatus;
    label: string;
    subject?: string;
    details: AnalysisActivityDetailV1[];
    startedAt: string;
    completedAt?: string;
    durationMs?: number;
    qualityMessages?: AnalysisActivityMessageV1[];
    /** @deprecated Use qualityMessages. Kept for persisted activity snapshots created by older versions. */
    warning?: string;
    query?: {
        artifactId: string;
        originalSql: string;
        executedSql: string;
        adjusted: boolean;
        rowCount: number;
        isLimited: boolean;
    };
}

export interface QueryPlanV1 {
    purpose: string;
    expectedGrain: string;
    expectedShape: QueryExpectedShape;
}

export type ResultQualitySeverity = 'info' | 'warning' | 'blocking';
export interface ResultQualityWarningV1 {
    code: 'RESULT_LIMITED' | 'TOOL_RESULT_TRUNCATED' | 'NULL_VALUES' | 'DUPLICATE_GRAIN' | 'JOIN_FANOUT_RISK' | 'TIMEZONE_ASSUMED' | 'EMPTY_RESULT';
    severity: ResultQualitySeverity;
    message: string;
    action: string;
}

export interface ResultQualityV1 {
    expectedGrain: string;
    expectedShape: QueryExpectedShape;
    observedRowCount: number;
    isLimited: boolean;
    toolResultTruncated: boolean;
    nullRates: Record<string, number>;
    duplicateKeyCount?: number;
    timeRange?: { column: string; min: string; max: string; timezone: string };
    warnings: ResultQualityWarningV1[];
}

export interface ExecuteSqlQueryArgsV2 {
    title: string;
    sql: string;
    plan: QueryPlanV1;
}

export interface ArtifactColumnV1 {
    name: string;
    type: ArtifactColumnType;
}

export interface QueryArtifactV1 {
    analysisContext?: import('./analysis').AnalysisEvidenceContext;
    id: string;
    generationId: string;
    userId: number;
    conversationId: string;
    datasourceId: number;
    title: string;
    plan: QueryPlanV1;
    originalSql: string;
    executedSql: string;
    schemaContextVersion: string;
    columns: ArtifactColumnV1[];
    returnedRowCount: number;
    totalRowCount?: number;
    isLimited: boolean;
    resultQuality?: ResultQualityV1;
    resultContentHash: string;
    createdAt: string;
    expiresAt?: string;
}

export interface QueryArtifactResultV1 {
    artifact: QueryArtifactV1;
    rows: Array<Record<string, unknown>>;
}

export interface ChartFieldV1 {
    field: string;
    label: string;
}

export interface ArtifactSortV1 {
    field: string;
    direction: 'asc' | 'desc';
}

export interface ChartArtifactV1 {
    id: string;
    generationId: string;
    queryArtifactId: string;
    chartType: ChartType;
    title: string;
    xField: string;
    yFields: ChartFieldV1[];
    sort?: ArtifactSortV1[];
    createdAt: string;
}

export interface ConversationTurnV1 {
    id: string;
    conversationId: string;
    sequence: number;
    generationId: string;
    userMessageId: string;
    assistantMessageId: string;
    status: 'pending' | 'completed' | 'failed' | 'cancelled';
    finalAnswer: string | null;
    createdAt: string;
    completedAt: string | null;
}

export interface SchemaCatalogSummaryV1 {
    datasourceId: number;
    tables: Array<{ schema: string; name: string; displayName: string; description?: string }>;
}

export interface SchemaDetailV1 {
    datasourceId: number;
    schema: string;
    table: string;
    columns: Array<{ name: string; type: string; description?: string }>;
}

export interface GenerationJob {
    version: 1;
    generationId: string;
}

export interface GenerationTerminalOutboxPayload {
    version: 1;
    kind: 'generation.terminal';
    generationId: string;
    userId: number;
    conversationId: string;
    messageId: string;
    event: ConversationEvent;
}

export function parseGenerationJob(value: unknown): GenerationJob {
    if (!value || typeof value !== 'object') throw new Error('INVALID_GENERATION_JOB');
    const candidate = value as Partial<GenerationJob>;
    if (candidate.version !== 1 || typeof candidate.generationId !== 'string' || !candidate.generationId) {
        throw new Error('INVALID_GENERATION_JOB');
    }
    return { version: 1, generationId: candidate.generationId };
}

export function parseGenerationTerminalOutboxPayload(value: unknown): GenerationTerminalOutboxPayload {
    if (!value || typeof value !== 'object') throw new Error('INVALID_TERMINAL_PAYLOAD');
    const candidate = value as Partial<GenerationTerminalOutboxPayload>;
    if (
        candidate.version !== 1 ||
        candidate.kind !== 'generation.terminal' ||
        typeof candidate.generationId !== 'string' ||
        typeof candidate.userId !== 'number' ||
        typeof candidate.conversationId !== 'string' ||
        typeof candidate.messageId !== 'string' ||
        !candidate.event ||
        typeof candidate.event !== 'object' ||
        typeof candidate.event.type !== 'string'
    )
        throw new Error('INVALID_TERMINAL_PAYLOAD');
    return candidate as GenerationTerminalOutboxPayload;
}

export interface SuggestionItem {
    id: string;
    text: string;
}

export interface SuggestionsBlock {
    type: 'suggestions';
    version: 1;
    items: SuggestionItem[];
}

export interface ConversationEvent {
    type:
        | 'sql'
        | 'sql_chunk'
        | 'table'
        | 'text'
        | 'text_chunk'
        | 'reasoning_chunk'
        | 'thinking'
        | 'error'
        | 'done'
        | 'log'
        | 'chart'
        | 'chart_loading'
        | 'log_update'
        | 'log_remove'
        | 'analysis_activity'
        | 'suggestions'
        | 'analysis_activity_remove';
    [key: string]: unknown;
}

export interface GenerationStreamEvent extends ConversationEvent {
    eventId: string;
    streamId: string;
    generationId: string;
    conversationId: string;
    messageId: string;
    sequence: number;
    occurredAt: string;
}

export interface ConversationEventEmitter {
    send(event: ConversationEvent): void;
}
export * from './memory';
export * from './schema-enrichment';
