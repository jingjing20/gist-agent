import type { SSEEvent } from './tools/base-tool';

/** Coalesce token fragments for at most one frame; never cross tool boundaries. */
export class TextEventBuffer {
    private pending: SSEEvent | undefined;
    private timer: ReturnType<typeof setTimeout> | undefined;

    constructor(private readonly publish: (event: SSEEvent) => void) {}

    send(event: SSEEvent): void {
        if (event.type !== 'text_chunk') {
            this.flush();
            this.publish(event);
            return;
        }
        if (this.pending) this.pending.content = String(this.pending.content || '') + String(event.content || '');
        else this.pending = { ...event };
        if (this.timer === undefined) this.timer = setTimeout(() => this.flush(), 16);
    }

    flush(): void {
        clearTimeout(this.timer);
        this.timer = undefined;
        const event = this.pending;
        this.pending = undefined;
        if (event) this.publish(event);
    }
}
