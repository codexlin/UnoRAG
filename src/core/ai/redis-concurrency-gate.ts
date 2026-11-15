import { randomUUID } from "node:crypto";
import {
	type AiConcurrencyGate,
	type AiConcurrencyGateLike,
	type AiConcurrencyLease,
	AiConcurrencyWaitTimeoutError,
} from "./concurrency-gate";

export interface RedisEvalClient {
	eval(
		script: string,
		options: { keys: string[]; arguments: string[] },
	): Promise<unknown>;
}

const ACQUIRE_PERMIT_LUA = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', tonumber(ARGV[1]))
local active = redis.call('ZCARD', KEYS[1])
if active < tonumber(ARGV[2]) then
  redis.call('ZADD', KEYS[1], tonumber(ARGV[3]), ARGV[4])
  redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[5]))
  return 1
end
return 0
`.trim();

const RELEASE_PERMIT_LUA = `
return redis.call('ZREM', KEYS[1], ARGV[1])
`.trim();

export type RedisAiConcurrencyGateOptions = Readonly<{
	localGate: AiConcurrencyGate;
	getRedisClient: () => Promise<RedisEvalClient>;
	globalLimit: number;
	key?: string;
	leaseTtlMs?: number;
	waitTimeoutMs?: number;
	pollIntervalMs?: number;
	failClosed?: boolean;
	onRedisFallback?: (error: unknown) => void;
}>;

/**
 * Coordinates LLM concurrency across Web replicas using a Redis ZSET lease
 * table on top of the local per-process `AiConcurrencyGate`.
 * Leases carry an expiration timestamp so crashed replicas never leak permits.
 */
export class RedisAiConcurrencyGate implements AiConcurrencyGateLike {
	readonly localGate: AiConcurrencyGate;
	readonly globalLimit: number;
	readonly key: string;
	readonly leaseTtlMs: number;
	readonly waitTimeoutMs: number;
	readonly pollIntervalMs: number;
	readonly failClosed: boolean;
	private readonly getRedisClient: () => Promise<RedisEvalClient>;
	private readonly onRedisFallback?: (error: unknown) => void;

	constructor(options: RedisAiConcurrencyGateOptions) {
		if (
			!Number.isSafeInteger(options.globalLimit) ||
			options.globalLimit <= 0
		) {
			throw new TypeError("globalLimit must be a positive integer");
		}
		this.localGate = options.localGate;
		this.getRedisClient = options.getRedisClient;
		this.globalLimit = options.globalLimit;
		this.key = options.key ?? "unorag:ai:inflight";
		this.leaseTtlMs = options.leaseTtlMs ?? 120_000;
		this.waitTimeoutMs =
			options.waitTimeoutMs ?? options.localGate.waitTimeoutMs;
		this.pollIntervalMs = options.pollIntervalMs ?? 40;
		this.failClosed = options.failClosed ?? false;
		this.onRedisFallback = options.onRedisFallback;
	}

	async acquire(signal?: AbortSignal): Promise<AiConcurrencyLease> {
		const startedAt = Date.now();
		const localLease = await this.localGate.acquire(signal);
		const token = randomUUID();
		const deadline = startedAt + this.waitTimeoutMs;

		while (true) {
			if (signal?.aborted) {
				localLease.release();
				throw abortError(signal);
			}

			let client: RedisEvalClient;
			let acquired = false;
			try {
				client = await this.getRedisClient();
				const now = Date.now();
				const result = await client.eval(ACQUIRE_PERMIT_LUA, {
					keys: [this.key],
					arguments: [
						String(now),
						String(this.globalLimit),
						String(now + this.leaseTtlMs),
						token,
						String(this.leaseTtlMs + 5_000),
					],
				});
				acquired = Number(result) === 1;
			} catch (error) {
				if (this.failClosed) {
					localLease.release();
					throw error;
				}
				this.onRedisFallback?.(error);
				return localLease;
			}

			if (acquired) {
				let released = false;
				return {
					release: () => {
						if (released) return;
						released = true;
						localLease.release();
						void client
							.eval(RELEASE_PERMIT_LUA, {
								keys: [this.key],
								arguments: [token],
							})
							.catch(() => undefined);
					},
				};
			}

			const remainingMs = deadline - Date.now();
			if (remainingMs <= 0) {
				localLease.release();
				throw new AiConcurrencyWaitTimeoutError(this.waitTimeoutMs);
			}

			const waitMs = Math.min(this.pollIntervalMs, remainingMs);
			await sleepWithSignal(waitMs, signal).catch((error) => {
				localLease.release();
				throw error;
			});
		}
	}
}

function abortError(signal: AbortSignal): unknown {
	return (
		signal.reason ??
		Object.assign(new Error("AI concurrency wait aborted"), {
			name: "AbortError",
		})
	);
}

function sleepWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) return Promise.reject(abortError(signal));
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			if (signal && onAbort) signal.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		let onAbort: (() => void) | undefined;
		if (signal) {
			onAbort = () => {
				clearTimeout(timer);
				reject(abortError(signal));
			};
			signal.addEventListener("abort", onAbort, { once: true });
		}
	});
}
