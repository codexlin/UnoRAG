import "server-only";

import {
	AiConcurrencyGate,
	type AiConcurrencyGateLike,
	RedisAiConcurrencyGate,
} from "@/core/ai";
import { logger } from "@/lib/observability";
import { getSecurityRedisClient } from "@/lib/server/security/redis";
import { observeAiConcurrency } from "@/server/observability/metrics";

const gateKey = Symbol.for("unorag.ai.concurrency-gate");

type CachedGateEntry = {
	localGate: AiConcurrencyGate;
	gate: AiConcurrencyGateLike;
	globalLimit: number | null;
	redisEnabled: boolean;
	failClosed: boolean;
};

export function getSharedAiConcurrencyGate(): AiConcurrencyGateLike {
	const limit = positiveEnvironmentInteger("LLM_MAX_INFLIGHT", 4);
	const maxQueue = positiveEnvironmentInteger("LLM_MAX_QUEUE", limit * 8);
	const waitTimeoutMs = positiveEnvironmentInteger(
		"LLM_QUEUE_TIMEOUT_MS",
		30_000,
	);
	const redisUrl = process.env.REDIS_URL?.trim() ?? "";
	const redisGateFlag =
		process.env.LLM_REDIS_GATE_ENABLED?.trim().toLowerCase();
	const redisEnabled = Boolean(redisUrl) && redisGateFlag !== "false";
	const globalLimit = redisEnabled
		? positiveEnvironmentInteger("LLM_GLOBAL_MAX_INFLIGHT", limit)
		: null;
	const failClosed =
		process.env.LLM_REDIS_GATE_FAIL_CLOSED?.trim().toLowerCase() === "true";

	const root = globalThis as typeof globalThis & {
		[gateKey]?: CachedGateEntry;
	};
	const existing = root[gateKey];
	if (
		existing &&
		(existing.localGate.limit !== limit ||
			existing.localGate.maxQueue !== maxQueue ||
			existing.localGate.waitTimeoutMs !== waitTimeoutMs ||
			existing.globalLimit !== globalLimit ||
			existing.redisEnabled !== redisEnabled ||
			existing.failClosed !== failClosed)
	) {
		throw new Error(
			"LLM concurrency configuration changed at runtime; restart the Web process",
		);
	}
	if (!root[gateKey]) {
		const localGate = new AiConcurrencyGate(limit, observeAiConcurrency, {
			maxQueue,
			waitTimeoutMs,
		});
		const gate: AiConcurrencyGateLike =
			redisEnabled && globalLimit !== null
				? new RedisAiConcurrencyGate({
						localGate,
						getRedisClient: getSecurityRedisClient,
						globalLimit,
						waitTimeoutMs,
						failClosed,
						onRedisFallback: (error) => {
							logger.warn({
								event: "ai.concurrency.redis_fallback",
								component: "ai-concurrency",
								error,
							});
						},
					})
				: localGate;
		root[gateKey] = {
			localGate,
			gate,
			globalLimit,
			redisEnabled,
			failClosed,
		};
	}
	observeAiConcurrency({
		type: "snapshot",
		snapshot: root[gateKey].localGate.snapshot(),
	});
	return root[gateKey].gate;
}

function positiveEnvironmentInteger(name: string, fallback: number): number {
	const raw = process.env[name]?.trim();
	if (!raw) return fallback;
	const value = Number(raw);
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new Error(`${name} must be a positive integer`);
	}
	return value;
}
