/** New core is opt-in until business and interaction acceptance is complete. */
export const ANALYSIS_RUNTIME_VERSIONS = {
    promptPolicy: 'analysis-core-v2',
    toolset: 'analysis-tools-v3',
    contextPolicy: 'analysis-context-v2',
    memoryPolicy: 'analysis-definitions-v1',
    schemaContext: 'schema-context-v4',
} as const;

export interface AnalysisFinding {
    id: string;
    text: string;
    kind: 'observation' | 'supported_explanation' | 'hypothesis';
    evidence: Array<{ artifactId: string; role: 'observation' | 'verification' | 'comparison'; comparisonLabel?: string }>;
}

export interface AnalysisAnswer {
    summary: string;
    findings: AnalysisFinding[];
    limitations: string[];
    unresolvedQuestions: string[];
}

export type AnalysisOutcome =
    | { kind: 'answer' | 'partial'; answer: AnalysisAnswer; reason?: string }
    | { kind: 'clarification'; question: string }
    | { kind: 'refusal'; explanation: string };

/** S1: immutable single-run context; cross-turn mutation is introduced in S3. */
export interface AnalysisRunSnapshot {
    taskId: string;
    datasourceId: number;
    stateRevision: number;
    requestMessageId: string;
    question: string;
    timeAnchor: string;
    definitionRefs: Array<{ id: string; version: number }>;
    schemaTables: string[];
}

export interface AnalysisState {
    taskId: string;
    conversationId: string;
    datasourceId: number;
    revision: number;
    question: string;
    status: 'active' | 'awaiting_clarification' | 'answered' | 'partial';
    definitionRefs: Array<{ id: string; version: number }>;
    temporaryDefinitions: Array<{ name: string; description: string; sourceMessageId: string }>;
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
    definitions: import('./business-definition').BusinessDefinition[];
}
