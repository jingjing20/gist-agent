export interface ChartSeries {
	name: string;
	data: number[];
}

export interface ChartData {
	chartType: 'line' | 'bar' | 'pie' | 'scatter';
	title: string;
	xAxis?: string[];
	series: ChartSeries[];
}

export interface SSEEvent {
	type: 'sql' | 'table' | 'text' | 'text_chunk' | 'error' | 'done' | 'log' | 'chart' | 'chart_loading' | 'log_update';
	content?: string;
	columns?: string[];
	rows?: Record<string, unknown>[];
	rowCount?: number;
	title?: string;
	chartData?: ChartData;
}

export interface MessageBlock {
	type: SSEEvent['type'];
	content?: string;
	columns?: string[];
	rows?: Record<string, unknown>[];
	rowCount?: number;
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
	messages: ChatMessage[];
	createdAt: number;
	updatedAt: number;
}
