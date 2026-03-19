import { Response } from 'express';
import type { SSEEvent, SSEEmitter } from './tools/base-tool';

export class StreamEmitter implements SSEEmitter {
	constructor(private readonly res: Response) {}

	send(event: SSEEvent): void {
		this.res.write(`data: ${JSON.stringify(event)}\n\n`);
	}

	done(): void {
		this.send({ type: 'done' });
	}
}
