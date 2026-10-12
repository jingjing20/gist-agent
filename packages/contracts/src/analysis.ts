/** Sole active analysis runtime. Persist these versions on each generation. */
export const ANALYSIS_RUNTIME_VERSIONS = {
    promptPolicy: 'analysis-core-v3',
    toolset: 'analysis-tools-v4',
    contextPolicy: 'analysis-context-v3',
    memoryPolicy: 'datasource-memory-v2',
    schemaContext: 'schema-context-v4',
} as const;

export type AnalysisCompletionStatus = 'complete' | 'partial' | 'awaiting_clarification' | 'unable_to_complete';

export type AnalysisContentBlock = { type: 'markdown'; content: string } | { type: 'table'; artifactId: string; title?: string } | { type: 'chart'; chartArtifactId: string };

export interface AnalysisOutcome {
    kind: 'response';
    status: AnalysisCompletionStatus;
    reason: string | null;
    missingItems: string[];
    blocks: AnalysisContentBlock[];
}

/** S1: immutable single-run context; cross-turn mutation is introduced in S3. */
export interface AnalysisRunSnapshot {
    taskId: string;
    datasourceId: number;
    stateRevision: number;
    requestMessageId: string;
    question: string;
    timeAnchor: string;
    memoryRefs: Array<{ id: string; version: number }>;
    schemaTables: string[];
}

export interface AnalysisState {
    taskId: string;
    conversationId: string;
    datasourceId: number;
    revision: number;
    question: string;
    status: 'active' | AnalysisCompletionStatus;
    memoryRefs: Array<{ id: string; version: number }>;
    temporaryNotes: Array<{ name: string; description: string; sourceMessageId: string }>;
    timeRange: { start: string; endExclusive: string; timezone: string } | null;
    comparisonRange: { start: string; endExclusive: string; timezone: string } | null;
    filters: Array<{ field: string; operator: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'in'; value: string | number | boolean | null | Array<string | number | boolean> }>;
    grain: string | null;
    freshness: 'reuse_allowed' | 'current_generation';
    hypotheses: Array<{ id: string; statement: string; status: 'open' | 'supported' | 'refuted' | 'unresolved'; evidenceIds: string[] }>;
    openQuestions: string[];
}
export interface AnalysisEvidenceContext {
    accessFingerprint?: string;
    state: AnalysisState;
    memories: import('./memory').DatasourceMemory[];
}
