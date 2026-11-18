import { createHash } from "node:crypto";
import type { AuthorizedScope } from "../contracts";
import type { RetrievalResult } from "./retrieval-service";

export type ScopedRetrievalCacheKeyInput = {
	query: string;
	libraryId: string;
	scope: AuthorizedScope;
	topK: number;
	filters: Record<string, unknown>;
	options: {
		hybridEnabled: boolean;
		rerankEnabled: boolean;
		preserveFigureLineage?: boolean;
		lineageMinScore?: number;
		expandParentContext?: boolean;
		rerankTopK: number;
		bm25TopK: number;
		rrfK: number;
	};
};

function canonicalizeRecord(
	record: Record<string, unknown>,
): Record<string, unknown> {
	const sorted: Record<string, unknown> = {};
	for (const key of Object.keys(record).sort()) {
		const value = record[key];
		if (value === undefined) continue;
		if (Array.isArray(value)) {
			sorted[key] = [...value].sort();
		} else if (value && typeof value === "object") {
			sorted[key] = canonicalizeRecord(value as Record<string, unknown>);
		} else {
			sorted[key] = value;
		}
	}
	return sorted;
}

/**
 * Derives a SHA-256 cache key bound to every authorization and generation
 * dimension (`organizationId`, `workspaceId`, `libraryId`, `libraryIds`,
 * `principalIds`, `groupIds`, `documentIds`, `activeGenerationIds`) so cached
 * retrieval results can never cross tenant, principal, or document-generation
 * boundaries.
 */
export function buildScopedRetrievalCacheKey(
	input: ScopedRetrievalCacheKeyInput,
): string {
	const canonicalPayload = {
		organizationId: input.scope.organizationId,
		workspaceId: input.scope.workspaceId,
		libraryId: input.libraryId,
		libraryIds: [...input.scope.libraryIds].sort(),
		principalIds: [...input.scope.principalIds].sort(),
		groupIds: [...input.scope.groupIds].sort(),
		documentIds:
			input.scope.documentIds === undefined
				? null
				: [...input.scope.documentIds].sort(),
		activeGenerationIds: [...input.scope.activeGenerationIds].sort(),
		query: input.query.trim(),
		topK: input.topK,
		filters: canonicalizeRecord(input.filters),
		options: {
			hybridEnabled: input.options.hybridEnabled,
			rerankEnabled: input.options.rerankEnabled,
			preserveFigureLineage: Boolean(input.options.preserveFigureLineage),
			lineageMinScore: input.options.lineageMinScore ?? null,
			rerankTopK: input.options.rerankTopK,
			bm25TopK: input.options.bm25TopK,
			rrfK: input.options.rrfK,
		},
	};
	return createHash("sha256")
		.update(JSON.stringify(canonicalPayload))
		.digest("hex");
}

type CacheEntry = {
	expiresAt: number;
	value: RetrievalResult;
};

/**
 * Bounded, short-TTL in-memory LRU cache for authorized retrieval results.
 * Clones values on write and read to prevent caller mutation from poisoning
 * subsequent hits.
 */
export class ScopedRetrievalCache {
	private readonly entries = new Map<string, CacheEntry>();
	readonly ttlMs: number;
	readonly maxEntries: number;
	private readonly now: () => number;

	constructor(options?: {
		ttlMs?: number;
		maxEntries?: number;
		now?: () => number;
	}) {
		this.ttlMs = options?.ttlMs ?? 30_000;
		this.maxEntries = options?.maxEntries ?? 256;
		this.now = options?.now ?? (() => Date.now());
	}

	get size(): number {
		return this.entries.size;
	}

	get(key: string): RetrievalResult | null {
		if (this.ttlMs <= 0 || this.maxEntries <= 0) return null;
		const entry = this.entries.get(key);
		if (!entry) return null;
		if (this.now() >= entry.expiresAt) {
			this.entries.delete(key);
			return null;
		}
		this.entries.delete(key);
		this.entries.set(key, entry);
		return structuredClone(entry.value);
	}

	set(key: string, value: RetrievalResult): void {
		if (this.ttlMs <= 0 || this.maxEntries <= 0) return;
		const now = this.now();
		if (this.entries.has(key)) {
			this.entries.delete(key);
		} else if (this.entries.size >= this.maxEntries) {
			this.evictOldestOrExpired(now);
		}
		this.entries.set(key, {
			expiresAt: now + this.ttlMs,
			value: structuredClone(value),
		});
	}

	clear(): void {
		this.entries.clear();
	}

	private evictOldestOrExpired(now: number): void {
		for (const [key, entry] of this.entries) {
			if (now >= entry.expiresAt) {
				this.entries.delete(key);
			}
		}
		while (this.entries.size >= this.maxEntries) {
			const oldestKey = this.entries.keys().next().value;
			if (oldestKey === undefined) break;
			this.entries.delete(oldestKey);
		}
	}
}
