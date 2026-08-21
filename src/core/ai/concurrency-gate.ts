export type AiConcurrencySnapshot = Readonly<{
	active: number;
	queued: number;
	limit: number;
}>;

export type AiConcurrencyOutcome =
	| "acquired"
	| "cancelled"
	| "overloaded"
	| "timed_out";

export type AiConcurrencyEvent =
	| Readonly<{ type: "snapshot"; snapshot: AiConcurrencySnapshot }>
	| Readonly<{
			type: "acquire";
			outcome: AiConcurrencyOutcome;
			waitDurationMs: number;
			snapshot: AiConcurrencySnapshot;
	  }>;

export interface AiConcurrencyLease {
	release(): void;
}

export interface AiConcurrencyGateLike {
	acquire(signal?: AbortSignal): Promise<AiConcurrencyLease>;
}

type QueueEntry = {
	startedAt: number;
	resolve: (lease: AiConcurrencyLease) => void;
	reject: (error: unknown) => void;
	signal?: AbortSignal;
	onAbort?: () => void;
	timeout?: NodeJS.Timeout;
};

export class AiConcurrencyOverloadedError extends Error {
	readonly code = "llm_overloaded";

	constructor() {
		super("LLM concurrency queue is full");
		this.name = "AiConcurrencyOverloadedError";
	}
}

export class AiConcurrencyWaitTimeoutError extends Error {
	readonly code = "llm_queue_timeout";

	constructor(readonly timeoutMs: number) {
		super(`LLM concurrency wait timed out after ${timeoutMs}ms`);
		this.name = "AiConcurrencyWaitTimeoutError";
	}
}

export type AiConcurrencyGateOptions = Readonly<{
	maxQueue?: number;
	waitTimeoutMs?: number;
}>;

export class AiConcurrencyGate implements AiConcurrencyGateLike {
	private active = 0;
	private readonly queue: QueueEntry[] = [];
	readonly maxQueue: number;
	readonly waitTimeoutMs: number;

	constructor(
		readonly limit: number,
		private readonly observe?: (event: AiConcurrencyEvent) => void,
		options: AiConcurrencyGateOptions = {},
	) {
		if (!Number.isSafeInteger(limit) || limit <= 0) {
			throw new TypeError("AI concurrency limit must be a positive integer");
		}
		this.maxQueue = positiveInteger(options.maxQueue, limit * 8, "maxQueue");
		this.waitTimeoutMs = positiveInteger(
			options.waitTimeoutMs,
			30_000,
			"waitTimeoutMs",
		);
	}

	acquire(signal?: AbortSignal): Promise<AiConcurrencyLease> {
		const startedAt = performance.now();
		if (signal?.aborted) {
			this.emit("cancelled", startedAt);
			return Promise.reject(abortReason(signal));
		}
		if (this.active < this.limit) {
			this.active += 1;
			const lease = this.createLease();
			this.emit("acquired", startedAt);
			return Promise.resolve(lease);
		}
		if (this.queue.length >= this.maxQueue) {
			this.emit("overloaded", startedAt);
			return Promise.reject(new AiConcurrencyOverloadedError());
		}

		return new Promise<AiConcurrencyLease>((resolve, reject) => {
			const entry: QueueEntry = { startedAt, resolve, reject, signal };
			if (signal) {
				entry.onAbort = () => {
					const index = this.queue.indexOf(entry);
					if (index < 0) return;
					this.queue.splice(index, 1);
					this.detach(entry);
					this.emit("cancelled", startedAt);
					reject(abortReason(signal));
				};
				signal.addEventListener("abort", entry.onAbort, { once: true });
			}
			entry.timeout = setTimeout(() => {
				const index = this.queue.indexOf(entry);
				if (index < 0) return;
				this.queue.splice(index, 1);
				this.detach(entry);
				this.emit("timed_out", startedAt);
				reject(new AiConcurrencyWaitTimeoutError(this.waitTimeoutMs));
			}, this.waitTimeoutMs);
			this.queue.push(entry);
			this.emitSnapshot();
		});
	}

	snapshot(): AiConcurrencySnapshot {
		return {
			active: this.active,
			queued: this.queue.length,
			limit: this.limit,
		};
	}

	private createLease(): AiConcurrencyLease {
		let released = false;
		return {
			release: () => {
				if (released) return;
				released = true;
				this.release();
			},
		};
	}

	private release(): void {
		if (this.active <= 0) {
			throw new Error("AI concurrency lease released without an active permit");
		}
		this.active -= 1;
		while (this.queue.length > 0 && this.active < this.limit) {
			const entry = this.queue.shift();
			if (!entry) break;
			this.detach(entry);
			if (entry.signal?.aborted) {
				this.emit("cancelled", entry.startedAt);
				entry.reject(abortReason(entry.signal));
				continue;
			}
			this.active += 1;
			entry.resolve(this.createLease());
			this.emit("acquired", entry.startedAt);
		}
		this.emitSnapshot();
	}

	private emit(outcome: AiConcurrencyOutcome, startedAt: number): void {
		this.safeObserve({
			type: "acquire",
			outcome,
			waitDurationMs: Math.max(0, performance.now() - startedAt),
			snapshot: this.snapshot(),
		});
	}

	private emitSnapshot(): void {
		this.safeObserve({ type: "snapshot", snapshot: this.snapshot() });
	}

	private detach(entry: QueueEntry): void {
		if (entry.onAbort && entry.signal) {
			entry.signal.removeEventListener("abort", entry.onAbort);
		}
		if (entry.timeout) clearTimeout(entry.timeout);
	}

	private safeObserve(event: AiConcurrencyEvent): void {
		try {
			this.observe?.(event);
		} catch {
			// Telemetry must never affect provider admission or permit release.
		}
	}
}

function abortReason(signal: AbortSignal): unknown {
	return (
		signal.reason ??
		Object.assign(new Error("AI concurrency wait aborted"), {
			name: "AbortError",
		})
	);
}

function positiveInteger(
	value: number | undefined,
	fallback: number,
	name: string,
): number {
	const resolved = value ?? fallback;
	if (!Number.isSafeInteger(resolved) || resolved <= 0) {
		throw new TypeError(`${name} must be a positive integer`);
	}
	return resolved;
}
