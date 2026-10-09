import type { AnalysisActivityV1, AnalysisOutcome, AnalysisState, SuggestionItem } from '@gist/contracts';
export interface AnalysisPresentation {
    outcome: AnalysisOutcome;
    state: AnalysisState;
    snapshot: { requestMessageId: string };
}
export interface ChartSeries {
    name: string;
    data: number[];
}

export interface ChartData {
    chartType: 'line' | 'bar' | 'pie' | 'scatter' | 'radar' | 'funnel';
    title: string;
    xAxis?: string[];
    series: ChartSeries[];
}

export interface ArtifactColumn {
    name: string;
    type: 'number' | 'string' | 'date' | 'boolean' | 'unknown';
}

export interface SSEEvent {
    display?: boolean;
    conversationId?: string;
    analysis?: AnalysisPresentation;
    type:
        | 'sql'
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
    content?: string;
    columns?: string[];
    columnTypes?: ArtifactColumn[];
    rows?: Record<string, unknown>[];
    rowCount?: number;
    isLimited?: boolean;
    queryArtifactId?: string;
    chartArtifactId?: string;
    resultContentHash?: string;
    title?: string;
    durationMs?: number;
    chartData?: ChartData;
    activity?: AnalysisActivityV1;
    activityId?: string;
    version?: 1;
    items?: SuggestionItem[];
}

export interface MessageBlock {
    version?: 1;
    items?: SuggestionItem[];
    display?: boolean;
    conversationId?: string;
    analysis?: AnalysisPresentation;
    type: SSEEvent['type'];
    content?: string;
    columns?: string[];
    columnTypes?: ArtifactColumn[];
    rows?: Record<string, unknown>[];
    rowCount?: number;
    isLimited?: boolean;
    queryArtifactId?: string;
    chartArtifactId?: string;
    resultContentHash?: string;
    title?: string;
    durationMs?: number;
    chartData?: ChartData;
    activity?: AnalysisActivityV1;
}

export interface ChatMessage {
    /** Transient render hint for text received in the current SSE batch. */
    animateText?: boolean;
    id: string;
    role: 'user' | 'assistant';
    content: string;
    blocks: MessageBlock[];
    timestamp: number;
}

export interface Conversation {
    id: string;
    title: string;
    datasource_id?: number | null;
    messages: ChatMessage[];
    createdAt: number;
    updatedAt: number;
}
