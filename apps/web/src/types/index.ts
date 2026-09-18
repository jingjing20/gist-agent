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
    type: 'sql' | 'table' | 'text' | 'text_chunk' | 'reasoning_chunk' | 'thinking' | 'error' | 'done' | 'log' | 'chart' | 'chart_loading' | 'log_update' | 'log_remove';
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
    chartData?: ChartData;
}

export interface MessageBlock {
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
    chartData?: ChartData;
}

export interface ChatMessage {
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

export interface MemoryRecord {
    id: string;
    scope: 'user' | 'datasource' | 'conversation';
    scopeId?: string;
    type: 'metric_definition' | 'dimension_definition' | 'analysis_preference' | 'locale_preference';
    key: string;
    value: Record<string, unknown>;
    sourceMessageId: string;
    sourceQuote?: string;
    status: 'proposed' | 'active';
    version: number;
    updatedAt: string;
}
