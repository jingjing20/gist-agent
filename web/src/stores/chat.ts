import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import type { Conversation, ChatMessage, MessageBlock, SSEEvent } from '../types';

const API_BASE = '/api';

export const useChatStore = defineStore('chat', () => {
	const conversations = ref<Conversation[]>([]);
	const activeConversationId = ref<string | null>(null);
	const isLoading = ref(false);

	const activeConversation = computed(() =>
		conversations.value.find((c) => c.id === activeConversationId.value),
	);

	async function fetchConversations() {
		const res = await fetch(`${API_BASE}/conversations`);
		const data = await res.json();
		conversations.value = data.map((c: any) => ({
			id: c.id,
			title: c.title,
			messages: [],
			createdAt: new Date(c.created_at).getTime(),
			updatedAt: new Date(c.updated_at).getTime(),
		}));
	}

	async function fetchMessages(conversationId: string) {
		const res = await fetch(`${API_BASE}/conversations/${conversationId}/messages`);
		const data = await res.json();
		const conv = conversations.value.find((c) => c.id === conversationId);
		if (!conv) return;

		conv.messages = data.map((m: any) => ({
			id: m.id,
			role: m.role,
			content: m.content || '',
			blocks: m.blocks || [],
			timestamp: new Date(m.created_at).getTime(),
		}));
	}

	async function createConversation(): Promise<Conversation> {
		const res = await fetch(`${API_BASE}/conversations`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ title: '新对话' }),
		});
		const data = await res.json();
		const conv: Conversation = {
			id: data.id,
			title: data.title,
			messages: [],
			createdAt: new Date(data.created_at).getTime(),
			updatedAt: new Date(data.updated_at).getTime(),
		};
		conversations.value.unshift(conv);
		activeConversationId.value = conv.id;
		return conv;
	}

	async function deleteConversation(id: string) {
		await fetch(`${API_BASE}/conversations/${id}`, { method: 'DELETE' });
		const idx = conversations.value.findIndex((c) => c.id === id);
		if (idx !== -1) conversations.value.splice(idx, 1);
		if (activeConversationId.value === id) {
			activeConversationId.value = conversations.value[0]?.id || null;
		}
	}

	async function selectConversation(id: string) {
		activeConversationId.value = id;
		const conv = conversations.value.find((c) => c.id === id);
		if (conv && conv.messages.length === 0) {
			await fetchMessages(id);
		}
	}

	function startNewChat() {
		activeConversationId.value = null;
	}

	async function sendMessage(content: string) {
		if (!activeConversationId.value) {
			await createConversation();
		}
		const conv = activeConversation.value;
		if (!conv) return;

		// 乐观更新: 先在本地加用户消息
		const userMsg: ChatMessage = {
			id: crypto.randomUUID(),
			role: 'user',
			content,
			blocks: [],
			timestamp: Date.now(),
		};
		conv.messages.push(userMsg);

		// 第一条消息更新标题
		if (conv.messages.length === 1) {
			conv.title = content.slice(0, 30) + (content.length > 30 ? '...' : '');
		}

		// 占位助手消息
		conv.messages.push({
			id: crypto.randomUUID(),
			role: 'assistant',
			content: '',
			blocks: [],
			timestamp: Date.now(),
		});
		const assistantMsg = conv.messages[conv.messages.length - 1];

		isLoading.value = true;

		try {
			const response = await fetch(`${API_BASE}/chat`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ message: content, conversationId: conv.id }),
			});

			if (!response.ok || !response.body) {
				throw new Error(`请求失败: ${response.status}`);
			}

			const reader = response.body.getReader();
			const decoder = new TextDecoder();
			let buffer = '';

			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split('\n');
				buffer = lines.pop() || '';

				for (const line of lines) {
					if (!line.startsWith('data: ')) continue;
					const jsonStr = line.slice(6).trim();
					if (!jsonStr) continue;

					try {
						const event: SSEEvent = JSON.parse(jsonStr);
						if (event.type === 'done') break;

						if (event.type === 'sql_chunk') {
							const lastBlock = assistantMsg.blocks[assistantMsg.blocks.length - 1];
							if (lastBlock?.type === 'sql') {
								lastBlock.content = (lastBlock.content || '') + (event.content || '');
							} else {
								assistantMsg.blocks.push({ type: 'sql', content: event.content || '' });
							}
							continue;
						}

						if (event.type === 'text_chunk') {
							const lastBlock = assistantMsg.blocks[assistantMsg.blocks.length - 1];
							if (lastBlock?.type === 'text') {
								lastBlock.content = (lastBlock.content || '') + (event.content || '');
							} else {
								assistantMsg.blocks.push({ type: 'text', content: event.content || '' });
							}
							continue;
						}

						const block: MessageBlock = {
							type: event.type,
							content: event.content,
							columns: event.columns,
							rows: event.rows,
							rowCount: event.rowCount,
							tables: event.tables,
							reason: event.reason,
						};
						assistantMsg.blocks.push(block);
					} catch {
						// skip malformed
					}
				}
			}

			conv.updatedAt = Date.now();
		} catch (err) {
			const errorMsg = err instanceof Error ? err.message : '请求失败';
			assistantMsg.blocks.push({ type: 'error', content: errorMsg });
		} finally {
			isLoading.value = false;
		}
	}

	return {
		conversations,
		activeConversationId,
		isLoading,
		activeConversation,
		fetchConversations,
		fetchMessages,
		createConversation,
		deleteConversation,
		selectConversation,
		startNewChat,
		sendMessage,
	};
});
