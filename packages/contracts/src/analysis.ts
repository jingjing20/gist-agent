/** New core is opt-in until business and interaction acceptance is complete. */
export const ANALYSIS_RUNTIME_VERSIONS = {
    promptPolicy: 'analysis-core-v1',
    toolset: 'analysis-tools-v1',
    contextPolicy: 'analysis-context-v1',
    memoryPolicy: 'analysis-definitions-fixture-v1',
    schemaContext: 'schema-context-v4',
} as const;

export interface AnalysisFinding {
    id: string;
    text: string;
    kind: 'observation' | 'supported_explanation' | 'hypothesis';
    evidence: Array<{ artifactId: string; role: 'observation' | 'verification' | 'comparison' }>;
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
