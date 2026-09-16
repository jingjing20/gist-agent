export type ThinkingState = 'active' | 'terminal';

export function thinkingStateKey(isStreaming: boolean): ThinkingState {
    return isStreaming ? 'active' : 'terminal';
}

export function initialThinkingExpanded(isStreaming: boolean): boolean {
    return isStreaming;
}
