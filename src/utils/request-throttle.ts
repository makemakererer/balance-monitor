import { sleep } from "./retry";

// Spaced single-flight queue: every enqueue() waits its turn behind earlier
// calls and ensures at least minSpacingMs has passed since the previous
// request started. Used by clients that talk to rate-limited HTTP APIs.
class RequestThrottle {
	private queueTail: Promise<unknown> = Promise.resolve();
	private lastRequestStartMs: number = 0;

	constructor(private readonly minSpacingMs: number) {}

	public enqueue<T>(executor: () => Promise<T>): Promise<T> {
		const next = this.queueTail.then(async () => {
			const sinceLastStart = Date.now() - this.lastRequestStartMs;
			if (sinceLastStart < this.minSpacingMs) {
				await sleep(this.minSpacingMs - sinceLastStart);
			}
			this.lastRequestStartMs = Date.now();
			return executor();
		});
		this.queueTail = next.catch(() => undefined);
		return next;
	}
}

export { RequestThrottle };
