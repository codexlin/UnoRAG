import assert from "node:assert/strict";
import test from "node:test";
import {
	AiConcurrencyGate,
	AiConcurrencyWaitTimeoutError,
	RedisAiConcurrencyGate,
	type RedisEvalClient,
} from "../../src/core/ai";
import { isSelfContainedFollowupQuestion } from "../../src/core/ask-graph/nodes/rewrite";
import type { AuthorizedScope } from "../../src/core/contracts";
import {
	buildScopedRetrievalCacheKey,
	DefaultRetrievalService,
	ScopedRetrievalCache,
} from "../../src/core/retrieval";

const BASE_SCOPE: AuthorizedScope = {
	organizationId: "org-1",
	workspaceId: "ws-1",
	principalIds: ["user-1"],
	groupIds: ["g-1", "g-2"],
	libraryIds: ["lib-1"],
	documentIds: ["doc-1", "doc-2"],
	activeGenerationIds: ["gen-1"],
};

test("isSelfContainedFollowupQuestion distinguishes standalone queries from coreference follow-ups", () => {
	assert.equal(
		isSelfContainedFollowupQuestion("报销审批流程中财务复核的时限是多少天？"),
		true,
	);
	assert.equal(
		isSelfContainedFollowupQuestion(
			"What is the retention period for audit logs?",
		),
		true,
	);
	assert.equal(isSelfContainedFollowupQuestion("为什么？"), false);
	assert.equal(
		isSelfContainedFollowupQuestion("那这个流程在周末怎么处理？"),
		false,
	);
	assert.equal(
		isSelfContainedFollowupQuestion("上述规则适用于实习生吗？"),
		false,
	);
	assert.equal(
		isSelfContainedFollowupQuestion("Can you elaborate on that policy?"),
		false,
	);
	assert.equal(
		isSelfContainedFollowupQuestion("Does it apply to contractors?"),
		false,
	);
});

test("buildScopedRetrievalCacheKey isolates every authorization and generation dimension", () => {
	const baseInput = {
		query: "年假结转规则",
		libraryId: "lib-1",
		scope: BASE_SCOPE,
		topK: 5,
		filters: { doc_id: "doc-1" },
		options: {
			hybridEnabled: true,
			rerankEnabled: true,
			rerankTopK: 6,
			bm25TopK: 20,
			rrfK: 60,
		},
	};
	const baseKey = buildScopedRetrievalCacheKey(baseInput);

	// Order-insensitive arrays produce the same key for identical scope.
	const reorderedKey = buildScopedRetrievalCacheKey({
		...baseInput,
		scope: {
			...BASE_SCOPE,
			groupIds: ["g-2", "g-1"],
			documentIds: ["doc-2", "doc-1"],
		},
	});
	assert.equal(reorderedKey, baseKey);

	// Changing any scope or generation dimension must produce a different key.
	const variants: AuthorizedScope[] = [
		{ ...BASE_SCOPE, organizationId: "org-2" },
		{ ...BASE_SCOPE, workspaceId: "ws-2" },
		{ ...BASE_SCOPE, principalIds: ["user-2"] },
		{ ...BASE_SCOPE, groupIds: ["g-1"] },
		{ ...BASE_SCOPE, libraryIds: ["lib-1", "lib-2"] },
		{ ...BASE_SCOPE, documentIds: ["doc-1"] },
		{ ...BASE_SCOPE, documentIds: undefined },
		{ ...BASE_SCOPE, documentIds: [] },
		{ ...BASE_SCOPE, activeGenerationIds: ["gen-2"] },
	];
	for (const scope of variants) {
		assert.notEqual(
			buildScopedRetrievalCacheKey({ ...baseInput, scope }),
			baseKey,
		);
	}
	assert.notEqual(
		buildScopedRetrievalCacheKey({ ...baseInput, libraryId: "lib-2" }),
		baseKey,
	);
	assert.notEqual(
		buildScopedRetrievalCacheKey({
			...baseInput,
			options: { ...baseInput.options, rerankSparseOnly: true },
		}),
		buildScopedRetrievalCacheKey({
			...baseInput,
			options: { ...baseInput.options, rerankSparseOnly: false },
		}),
	);
});

test("DefaultRetrievalService uses ScopedRetrievalCache safely without cross-scope leaks or TTL staleness", async () => {
	let nowMs = 1_000;
	let embedCalls = 0;
	let searchCalls = 0;
	const cache = new ScopedRetrievalCache({
		ttlMs: 5_000,
		maxEntries: 16,
		now: () => nowMs,
	});

	const service = new DefaultRetrievalService(
		{
			embedQuery: async () => {
				embedCalls += 1;
				return [0.1, 0.2, 0.3];
			},
			embedTexts: async (texts) => texts.map(() => [0.1, 0.2, 0.3]),
		},
		{
			search: async (input) => {
				searchCalls += 1;
				return [
					{
						id: "pt-1",
						score: 0.91,
						dense_score: 0.91,
						payload: {
							tenant_id: "org-1",
							workspace_id: "ws-1",
							library_id: "lib-1",
							doc_id: "doc-1",
							generation_id: input.scope.activeGenerationIds[0] ?? "gen-1",
							document_version_id: "ver-1",
							chunk_id: "chunk-1",
							chunk_index: 0,
							record_type: "chunk",
							body: "年假最多结转 5 天。",
							text: "年假最多结转 5 天。",
							title: "员工手册",
							heading_path: ["休假制度"],
							page_start: 3,
							page_end: 3,
							acl_scope: "workspace",
							acl_principals: ["user-1"],
							acl_groups: ["g-1"],
						},
					},
				];
			},
			listCorpus: async () => [],
		},
		null,
		{
			hybridEnabled: false,
			rerankEnabled: false,
			rerankTopK: 6,
			bm25TopK: 20,
			rrfK: 60,
			cache,
		},
	);

	const first = await service.retrieve({
		query: "年假结转",
		libraryId: "lib-1",
		scope: BASE_SCOPE,
		topK: 4,
	});
	assert.equal(embedCalls, 1);
	assert.equal(searchCalls, 1);
	assert.equal(first.citations.length, 1);

	// Caller mutation must not corrupt cached entries.
	first.citations[0].snippet = "mutated";

	const second = await service.retrieve({
		query: "年假结转",
		libraryId: "lib-1",
		scope: BASE_SCOPE,
		topK: 4,
	});
	assert.equal(embedCalls, 1);
	assert.equal(searchCalls, 1);
	assert.equal(second.citations[0]?.snippet, "年假最多结转 5 天。");

	// Different activeGenerationIds must miss cache.
	await service.retrieve({
		query: "年假结转",
		libraryId: "lib-1",
		scope: { ...BASE_SCOPE, activeGenerationIds: ["gen-2"] },
		topK: 4,
	});
	assert.equal(embedCalls, 2);
	assert.equal(searchCalls, 2);

	// Advance past TTL -> must miss cache and re-execute.
	nowMs += 6_000;
	await service.retrieve({
		query: "年假结转",
		libraryId: "lib-1",
		scope: BASE_SCOPE,
		topK: 4,
	});
	assert.equal(embedCalls, 3);
	assert.equal(searchCalls, 3);
});

function createInMemoryRedisEvalClient(): RedisEvalClient {
	const zsets = new Map<string, Map<string, number>>();
	return {
		async eval(script, { keys, arguments: args }) {
			const key = keys[0];
			let set = zsets.get(key);
			if (!set) {
				set = new Map();
				zsets.set(key, set);
			}
			if (script.includes("ZCARD")) {
				const minScore = Number(args[0]);
				for (const [member, score] of set) {
					if (score <= minScore) set.delete(member);
				}
				const limit = Number(args[1]);
				if (set.size < limit) {
					set.set(args[3], Number(args[2]));
					return 1;
				}
				return 0;
			}
			if (script.includes("ZREM")) {
				return set.delete(args[0]) ? 1 : 0;
			}
			throw new Error("unexpected lua script");
		},
	};
}

test("RedisAiConcurrencyGate coordinates permits across replicas and handles timeout/fallback", async () => {
	const redis = createInMemoryRedisEvalClient();
	const replicaA = new RedisAiConcurrencyGate({
		localGate: new AiConcurrencyGate(4),
		getRedisClient: async () => redis,
		globalLimit: 2,
		waitTimeoutMs: 120,
		pollIntervalMs: 10,
	});
	const replicaB = new RedisAiConcurrencyGate({
		localGate: new AiConcurrencyGate(4),
		getRedisClient: async () => redis,
		globalLimit: 2,
		waitTimeoutMs: 120,
		pollIntervalMs: 10,
	});

	const lease1 = await replicaA.acquire();
	const lease2 = await replicaB.acquire();

	// 3rd acquire across replicas exceeds globalLimit=2 and times out, releasing local gate.
	await assert.rejects(() => replicaA.acquire(), AiConcurrencyWaitTimeoutError);
	assert.equal(replicaA.localGate.snapshot().active, 1);

	lease1.release();
	const lease3 = await replicaA.acquire();
	lease2.release();
	lease3.release();
	assert.equal(replicaA.localGate.snapshot().active, 0);
	assert.equal(replicaB.localGate.snapshot().active, 0);

	// Fail-soft fallback when Redis errors and failClosed=false.
	let fallbackCount = 0;
	const failSoftGate = new RedisAiConcurrencyGate({
		localGate: new AiConcurrencyGate(2),
		getRedisClient: async () => {
			throw new Error("redis down");
		},
		globalLimit: 2,
		failClosed: false,
		onRedisFallback: () => {
			fallbackCount += 1;
		},
	});
	const fallbackLease = await failSoftGate.acquire();
	assert.equal(fallbackCount, 1);
	fallbackLease.release();

	// Fail-closed rejects when Redis errors and failClosed=true, releasing local permit.
	const failClosedGate = new RedisAiConcurrencyGate({
		localGate: new AiConcurrencyGate(2),
		getRedisClient: async () => {
			throw new Error("redis down");
		},
		globalLimit: 2,
		failClosed: true,
	});
	await assert.rejects(() => failClosedGate.acquire(), /redis down/);
	assert.equal(failClosedGate.localGate.snapshot().active, 0);
});
