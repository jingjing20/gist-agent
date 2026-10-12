import { computed, ref, nextTick } from 'vue';
import { defineStore } from 'pinia';
import { useRouter } from 'vue-router';
import type { ChatMessage, Conversation, MessageBlock, SSEEvent } from '../types';
import { apiFetch } from '../api';
import { useToastStore } from './toast';

type GenerationStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
interface GenerationState {
    id: string;
    conversationId: string;
    messageId: string;
    status: GenerationStatus;
    sequence: number;
}
interface UserGenerationEvent extends SSEEvent {
    eventId: string;
    streamId: string;
    generationId: string;
    conversationId: string;
    messageId: string;
    sequence: number;
    status?: GenerationStatus;
}

export const useChatStore = defineStore('chat', () => {
    const router = useRouter();
    const toast = useToastStore();
    const conversations = ref<Conversation[]>([]);
    const activeConversationId = ref<string | null>(null);
    const activeDatasourceId = ref<number | null>(null);
    const generations = ref<Record<string, GenerationState>>({});
    const connectionState = ref<'connecting' | 'connected' | 'disconnected'>('disconnected');
    const reasoningEnabled = ref(false);
    let realtimeStarted = false;
    let realtimeAbort: AbortController | null = null;

    const activeConversation = computed(() => conversations.value.find((c) => c.id === activeConversationId.value));
    const activeGeneration = computed(() =>
        Object.values(generations.value).find((g) => g.conversationId === activeConversationId.value && ['pending', 'running'].includes(g.status))
    );
    const isLoading = computed(() => !!activeGeneration.value);

    const toConversation = (c: any, previous?: Conversation): Conversation => ({
        id: c.id,
        title: c.title,
        datasource_id: c.datasource_id,
        messages: previous?.messages ?? [],
        createdAt: new Date(c.created_at).getTime(),
        updatedAt: new Date(c.updated_at).getTime(),
    });

    async function fetchConversations() {
        const res = await apiFetch('/conversations');
        const data = await res.json();
        const old = new Map(conversations.value.map((c) => [c.id, c]));
        conversations.value = data.map((c: any) => toConversation(c, old.get(c.id)));
        startRealtime();
    }

    async function fetchMessages(conversationId: string) {
        const res = await apiFetch(`/conversations/${conversationId}/messages`);
        const data = await res.json();
        const conv = conversations.value.find((c) => c.id === conversationId);
        if (!conv) return;
        for (const message of data) {
            if (!message.generation_id) continue;
            const rawStatus = String(message.generation_status || 'completed');
            const status: GenerationStatus = rawStatus === 'cancel_requested' || rawStatus === 'starting' ? 'running' : (rawStatus as GenerationStatus);
            generations.value[message.generation_id] = {
                id: message.generation_id,
                conversationId,
                messageId: message.id,
                status,
                sequence: Number(message.generation_sequence) || 0,
            };
        }
        const live = new Map(
            conv.messages.filter((m) => Object.values(generations.value).some((g) => g.messageId === m.id && ['pending', 'running'].includes(g.status))).map((m) => [m.id, m])
        );
        conv.messages = data.map(
            (m: any) => live.get(m.id) ?? { id: m.id, role: m.role, content: m.content || '', blocks: m.blocks || [], timestamp: new Date(m.created_at).getTime() }
        );
    }

    async function createConversation(): Promise<Conversation> {
        const res = await apiFetch('/conversations', { method: 'POST', body: JSON.stringify({ title: '新对话' }) });
        const data = await res.json();
        const conv = toConversation(data);
        conversations.value.unshift(conv);
        activeConversationId.value = conv.id;
        return conv;
    }

    async function deleteConversation(id: string) {
        const running = Object.values(generations.value).find((g) => g.conversationId === id && ['pending', 'running'].includes(g.status));
        if (running) await cancelGeneration(running.id);
        const response = await apiFetch(`/conversations/${id}`, { method: 'DELETE' });
        if (!response.ok) {
            const error = await response.json().catch(() => ({}));
            throw new Error(error.message || '删除失败，请重试');
        }
        conversations.value = conversations.value.filter((c) => c.id !== id);
        if (activeConversationId.value === id) {
            const next = conversations.value[0]?.id;
            next ? await selectConversation(next) : startNewChat();
        }
    }

    async function selectConversation(id: string) {
        activeConversationId.value = id;
        await router.replace(`/chat/${id}`);
        const conv = conversations.value.find((c) => c.id === id);
        if (conv?.datasource_id) activeDatasourceId.value = conv.datasource_id;
        if (conv && conv.messages.length === 0) await fetchMessages(id);
    }

    function startNewChat() {
        activeConversationId.value = null;
        void router.replace('/chat');
    }

    async function sendMessage(content: string): Promise<boolean> {
        if (!activeConversationId.value) await createConversation();
        const conv = activeConversation.value;
        if (!conv) return false;
        const localUserId = crypto.randomUUID();
        conv.messages.push({ id: localUserId, role: 'user', content, blocks: [], timestamp: Date.now() });
        if (conv.messages.length === 1) {
            conv.title = content.slice(0, 30) + (content.length > 30 ? '...' : '');
            void router.replace(`/chat/${conv.id}`);
        }
        try {
            const response = await apiFetch('/chat', {
                method: 'POST',
                headers: { 'Idempotency-Key': crypto.randomUUID() },
                body: JSON.stringify({ message: content, conversationId: conv.id, datasourceId: activeDatasourceId.value, reasoningEnabled: reasoningEnabled.value }),
            });
            if (!response.ok) {
                const problem = await response.json().catch(() => null);
                if (response.status === 409 && problem?.code === 'CONVERSATION_GENERATION_ACTIVE') {
                    throw new Error('当前对话正在生成回复，请等待完成或先取消');
                }
                if (response.status === 429) throw new Error(problem?.message || '当前生成任务过多，请稍后重试');
                throw new Error(problem?.message || `请求失败: ${response.status}`);
            }
            const data = await response.json();
            const user = conv.messages.find((m) => m.id === localUserId);
            if (user) user.id = data.userMessageId;
            if (!conv.messages.some((m) => m.id === data.responseMessageId))
                conv.messages.push({ id: data.responseMessageId, role: 'assistant', content: '', blocks: [], timestamp: Date.now() });
            generations.value[data.generationId] = { id: data.generationId, conversationId: conv.id, messageId: data.responseMessageId, status: 'pending', sequence: 0 };
            return true;
        } catch (error) {
            conv.messages = conv.messages.filter((m) => m.id !== localUserId);
            toast.error('发送失败: ' + (error instanceof Error ? error.message : '未知错误'));
            return false;
        }
    }

    function applyEvent(event: UserGenerationEvent): 'applied' | 'duplicate' | 'gap' {
        const current = generations.value[event.generationId];
        if (current && event.sequence <= current.sequence) return 'duplicate';
        const state = current ?? { id: event.generationId, conversationId: event.conversationId, messageId: event.messageId, status: 'running' as const, sequence: 0 };
        if (event.sequence > state.sequence + 1) return 'gap';
        state.sequence = event.sequence;
        if (event.type === 'done') state.status = event.status ?? 'completed';
        else if (event.type === 'error') state.status = event.content === '已取消' ? 'cancelled' : 'failed';
        else state.status = 'running';
        generations.value[event.generationId] = state;
        const conv = conversations.value.find((c) => c.id === event.conversationId);
        if (!conv) return 'applied';
        let message = conv.messages.find((m) => m.id === event.messageId);
        if (!message) {
            message = { id: event.messageId, role: 'assistant', content: '', blocks: [], timestamp: Date.now() };
            conv.messages.push(message);
        }
        applyBlock(message, event);
        conv.updatedAt = Date.now();
        if (event.type === 'done') void fetchMessages(event.conversationId);
        return 'applied';
    }

    async function resync(generationId: string) {
        const current = generations.value[generationId];
        if (!current) return;
        const response = await apiFetch(`/chat/generations/${generationId}/events?after_sequence=${current.sequence}`);
        const history = await response.json();
        if (history.mode === 'events') {
            for (const event of history.events) applyEvent(event);
        } else {
            current.sequence = history.snapshot.sequence;
            current.status = history.snapshot.status;
            const conv = conversations.value.find((c) => c.id === current.conversationId);
            const message = conv?.messages.find((m) => m.id === current.messageId);
            if (message) {
                message.content = history.snapshot.content || '';
                message.blocks = history.snapshot.blocks || [];
            }
        }
    }

    function applyBlock(message: ChatMessage, event: SSEEvent) {
        if (event.type === 'done') return;
        if (event.type === 'text' || event.type === 'text_chunk') {
            // Result and done can arrive in the same read, before Vue renders.
            message.animateText = true;
            void nextTick(() => {
                message.animateText = false;
            });
        }
        if (event.type === 'analysis_activity' && event.activity) {
            const index = message.blocks.findIndex((block) => block.type === 'analysis_activity' && block.activity?.id === event.activity?.id);
            const block: MessageBlock = { type: 'analysis_activity', activity: event.activity };
            if (index >= 0) message.blocks[index] = block;
            else message.blocks.push(block);
            return;
        }
        if (event.type === 'analysis_activity_remove') {
            const index = message.blocks.findIndex((block) => block.type === 'analysis_activity' && block.activity?.id === event.activityId);
            if (index >= 0) message.blocks.splice(index, 1);
            return;
        }
        if (event.type === 'text_chunk') {
            const last = message.blocks.at(-1);
            last?.type === 'text' ? (last.content = (last.content || '') + (event.content || '')) : message.blocks.push({ type: 'text', content: event.content || '' });
            return;
        }
        if (event.type === 'reasoning_chunk') {
            return;
        }
        if (event.type === 'chart_loading') {
            message.blocks.push({ type: 'chart' });
            return;
        }
        if (event.type === 'log_update') {
            const item = [...message.blocks].reverse().find((b) => b.type === 'log' && b.title === event.title && String(b.content || '').startsWith('正在'));
            if (item) {
                item.content = event.content;
                item.rowCount = event.rowCount;
                item.durationMs = event.durationMs;
            }
            return;
        }
        if (event.type === 'log_remove') {
            let index = -1;
            for (let i = message.blocks.length - 1; i >= 0; i--) {
                const block = message.blocks[i];
                if (block.type === 'log' && block.title === event.title && String(block.content || '').startsWith('正在')) {
                    index = i;
                    break;
                }
            }
            if (index >= 0) message.blocks.splice(index, 1);
            return;
        }
        if (event.type === 'chart') {
            const item = [...message.blocks].reverse().find((b) => b.type === 'chart' && !b.chartData);
            if (item) {
                item.chartData = event.chartData;
                item.queryArtifactId = event.queryArtifactId;
                item.chartArtifactId = event.chartArtifactId;
            } else {
                message.blocks.push({
                    type: 'chart',
                    chartData: event.chartData,
                    queryArtifactId: event.queryArtifactId,
                    chartArtifactId: event.chartArtifactId,
                });
            }
            return;
        }
        const block: MessageBlock = {
            version: event.version,
            items: event.items,
            display: event.display,
            conversationId: event.conversationId,
            analysis: event.analysis,
            memoryNotice: event.memoryNotice,
            type: event.type,
            content: event.content,
            columns: event.columns,
            columnTypes: event.columnTypes,
            rows: event.rows,
            rowCount: event.rowCount,
            isLimited: event.isLimited,
            queryArtifactId: event.queryArtifactId,
            chartArtifactId: event.chartArtifactId,
            resultContentHash: event.resultContentHash,
            title: event.title,
            durationMs: event.durationMs,
            chartData: event.chartData,
            activity: event.activity,
        };
        message.blocks.push(block);
    }

    async function startRealtime() {
        if (realtimeStarted) return;
        realtimeStarted = true;
        const cursorKey = `chat_event_cursor:${(localStorage.getItem('auth_token') || 'anonymous').slice(-16)}`;
        let cursor = sessionStorage.getItem(cursorKey) || '0-0';
        try {
            const known = Object.keys(generations.value).slice(0, 100).join(',');
            const sync = await (await apiFetch(`/chat/sync${known ? `?known_generation_ids=${known}` : ''}`)).json();
            for (const g of sync.activeGenerations) {
                generations.value[g.generation_id] = { id: g.generation_id, conversationId: g.conversation_id, messageId: g.message_id, status: g.status, sequence: 0 };
                await resync(g.generation_id);
            }
            for (const g of sync.reconciledGenerations) {
                const current = generations.value[g.generation_id];
                if (current) {
                    current.status = g.status;
                    current.sequence = Number(g.last_sequence);
                }
            }
            cursor = sync.eventCursor;
        } catch {
            /* SSE 重连会继续恢复 */
        }
        let retry = 1000;
        while (realtimeStarted) {
            realtimeAbort = new AbortController();
            connectionState.value = 'connecting';
            try {
                const response = await apiFetch(`/chat/events?after=${cursor}`, { signal: realtimeAbort.signal });
                if (!response.ok || !response.body) throw new Error('实时连接失败');
                connectionState.value = 'connected';
                retry = 1000;
                const reader = response.body.getReader(),
                    decoder = new TextDecoder();
                let buffer = '';
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    buffer += decoder.decode(value, { stream: true });
                    const frames = buffer.split('\n\n');
                    buffer = frames.pop() || '';
                    for (const frame of frames) {
                        const line = frame.split('\n').find((item) => item.startsWith('data: '));
                        if (!line) continue;
                        const event = JSON.parse(line.slice(6)) as UserGenerationEvent;
                        if (applyEvent(event) === 'gap') {
                            await resync(event.generationId);
                            applyEvent(event);
                        }
                        cursor = event.streamId;
                        sessionStorage.setItem(cursorKey, cursor);
                    }
                }
            } catch (error) {
                if (!realtimeStarted) break;
                connectionState.value = 'disconnected';
            }
            await new Promise((resolve) => setTimeout(resolve, retry));
            retry = Math.min(retry * 2, 15000);
        }
    }

    async function cancelGeneration(id: string) {
        await apiFetch(`/chat/generations/${id}/cancel`, { method: 'POST' });
    }
    async function retryGeneration(id: string): Promise<boolean> {
        try {
            const response = await apiFetch(`/chat/generations/${id}/retry`, { method: 'POST' });
            if (!response.ok) {
                const problem = await response.json().catch(() => null);
                throw new Error(problem?.message || `请求失败: ${response.status}`);
            }
            const data = await response.json();
            generations.value[data.generationId] = {
                id: data.generationId,
                conversationId: data.conversationId,
                messageId: data.responseMessageId,
                status: 'pending',
                sequence: 0,
            };
            await fetchMessages(data.conversationId);
            return true;
        } catch (error) {
            toast.error('重新分析失败: ' + (error instanceof Error ? error.message : '未知错误'));
            return false;
        }
    }
    function abortStream() {
        if (activeGeneration.value) void cancelGeneration(activeGeneration.value.id);
    }
    function clear() {
        conversations.value = [];
        activeConversationId.value = null;
        activeDatasourceId.value = null;
        generations.value = {};
        realtimeStarted = false;
        realtimeAbort?.abort();
    }
    return {
        conversations,
        activeConversationId,
        activeDatasourceId,
        activeConversation,
        generations,
        activeGeneration,
        connectionState,
        reasoningEnabled,
        isLoading,
        fetchConversations,
        fetchMessages,
        createConversation,
        deleteConversation,
        selectConversation,
        startNewChat,
        sendMessage,
        abortStream,
        retryGeneration,
        clear,
    };
});
