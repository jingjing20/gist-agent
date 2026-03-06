export interface SSEEvent {
	type: 'thinking' | 'sql' | 'sql_chunk' | 'table' | 'text' | 'text_chunk' | 'error' | 'done' | 'need_auth' | 'log';
	content?: string;
	columns?: string[];
	rows?: Record<string, unknown>[];
	rowCount?: number;
	tables?: string[];
	reason?: string;
	title?: string;
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
