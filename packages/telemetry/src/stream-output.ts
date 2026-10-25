// One bounded accumulator per model call; tool argument fragments are never parsed/executed.
export class StreamOutput {
    private remaining = 24000;
    private content = '';
    private truncated = false;
    private calls = new Map<number, { id: string; type: string; function: { name: string; arguments: string } }>();
    private append(current: string, part?: string): string {
        if (!part) return current;
        let low = 0,
            high = Math.min(part.length, this.remaining);
        while (low < high) {
            const mid = Math.ceil((low + high) / 2);
            if (Buffer.byteLength(JSON.stringify(part.slice(0, mid))) <= this.remaining) low = mid;
            else high = mid - 1;
        }
        if (low && /[\uD800-\uDBFF]/.test(part[low - 1])) low--;
        const value = part.slice(0, low);
        this.remaining = Math.max(0, this.remaining - Buffer.byteLength(JSON.stringify(value)));
        if (low < part.length) this.truncated = true;
        return current + value;
    }
    add(delta?: { content?: string | null; tool_calls?: { index: number; id?: string; type?: string; function?: { name?: string; arguments?: string } }[] }) {
        if (!delta) return;
        this.content = this.append(this.content, delta.content ?? undefined);
        for (const fragment of delta.tool_calls ?? []) {
            if (!Number.isInteger(fragment.index) || fragment.index < 0) continue;
            if (!this.calls.has(fragment.index)) {
                if (this.calls.size >= 32) {
                    this.truncated = true;
                    continue;
                }
                this.calls.set(fragment.index, { id: '', type: 'function', function: { name: '', arguments: '' } });
            }
            const call = this.calls.get(fragment.index)!;
            call.id = this.append(call.id, fragment.id);
            call.function.name = this.append(call.function.name, fragment.function?.name);
            call.function.arguments = this.append(call.function.arguments, fragment.function?.arguments);
        }
    }
    result() {
        if (!this.content && !this.calls.size && !this.truncated) return undefined;
        return {
            value: { role: 'assistant', content: this.content || null, tool_calls: [...this.calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call) },
            truncated: this.truncated,
        };
    }
}
