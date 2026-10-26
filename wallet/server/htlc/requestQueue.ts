export class HtlcQueueFullError extends Error {
	constructor() { super('The HTLC request queue is full. Wait for current operations to finish before trying again.'); }
}

interface Waiter {
	signal: AbortSignal;
	resolve: (release: () => void) => void;
	reject: (cause: unknown) => void;
	cancel: () => void;
}

/** Bounded FIFO admission. Every granted lease has an idempotent release. */
export class HtlcRequestQueue {
	private active = 0;
	private waiting: Waiter[] = [];
	constructor(private readonly concurrency = 2, private readonly capacity = 8) {}

	acquire(signal: AbortSignal): Promise<() => void> {
		signal.throwIfAborted();
		if (this.active < this.concurrency) return Promise.resolve(this.lease());
		if (this.waiting.length >= this.capacity) return Promise.reject(new HtlcQueueFullError());
		return new Promise((resolve, reject) => {
			const waiter: Waiter = { signal, resolve, reject, cancel: () => {
				this.waiting = this.waiting.filter((item) => item !== waiter);
				reject(signal.reason);
			} };
			this.waiting.push(waiter);
			signal.addEventListener('abort', waiter.cancel, { once: true });
		});
	}

	private lease(): () => void {
		this.active++;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.active--;
			while (this.active < this.concurrency && this.waiting.length) {
				const waiter = this.waiting.shift()!;
				waiter.signal.removeEventListener('abort', waiter.cancel);
				if (waiter.signal.aborted) waiter.reject(waiter.signal.reason);
				else waiter.resolve(this.lease());
			}
		};
	}
}

// Abort the HTTP lifecycle even when an import or another awaited operation
// doesn't observe the signal. The operation itself must also check cancellation
// before starting work or changing signing state.
export function untilAborted<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
	return new Promise((resolve, reject) => {
		const cancel = () => reject(signal.reason);
		if (signal.aborted) cancel();
		else signal.addEventListener('abort', cancel, { once: true });
		operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel));
	});
}
