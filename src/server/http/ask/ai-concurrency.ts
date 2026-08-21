import "server-only";

import { AiConcurrencyGate } from "@/core/ai";
import { observeAiConcurrency } from "@/server/observability/metrics";

const gateKey = Symbol.for("unorag.ai.concurrency-gate");

export function getSharedAiConcurrencyGate(): AiConcurrencyGate {
	const limit = positiveEnvironmentInteger("LLM_MAX_INFLIGHT", 4);
	const maxQueue = positiveEnvironmentInteger("LLM_MAX_QUEUE", limit * 8);
	const waitTimeoutMs = positiveEnvironmentInteger(
		"LLM_QUEUE_TIMEOUT_MS",
		30_000,
	);
	const root = globalThis as typeof globalThis & {
		[gateKey]?: AiConcurrencyGate;
	};
	if (
		root[gateKey] &&
		(root[gateKey].limit !== limit ||
			root[gateKey].maxQueue !== maxQueue ||
			root[gateKey].waitTimeoutMs !== waitTimeoutMs)
	) {
		throw new Error(
			"LLM concurrency configuration changed at runtime; restart the Web process",
		);
	}
	root[gateKey] ??= new AiConcurrencyGate(limit, observeAiConcurrency, {
		maxQueue,
		waitTimeoutMs,
	});
	observeAiConcurrency({
		type: "snapshot",
		snapshot: root[gateKey].snapshot(),
	});
	return root[gateKey];
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
