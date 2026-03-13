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
	type: 'thinking' | 'sql' | 'sql_chunk' | 'table' | 'text' | 'text_chunk' | 'error' | 'done' | 'need_auth' | 'log' | 'chart' | 'chart_loading';
	content?: string;
	columns?: string[];
	rows?: Record<string, unknown>[];
	rowCount?: number;
	tables?: string[];
	reason?: string;
	title?: string;
	chartData?: ChartData;
}

export interface MessageBlock {
	type: SSEEvent['type'];
	content?: string;
	columns?: string[];
	rows?: Record<string, unknown>[];
	rowCount?: number;
	tables?: string[];
	reason?: string;
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
