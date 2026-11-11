import assert from "node:assert/strict";
import test from "node:test";
import { APICallError, type LanguageModel } from "ai";
import {
	AiConcurrencyOverloadedError,
	AiConcurrencyWaitTimeoutError,
} from "../../src/core/ai/concurrency-gate";
import {
	assessEvidenceWithMetadata,
	getEvidenceAssessmentFailureMetadata,
} from "../../src/core/ai/evidence-assessment";
import {
	type EvidenceAssessmentFailureMetadata,
	EvidenceAssessmentValidationError,
} from "../../src/core/ai/evidence-assessment-diagnostics";
import { createEvidenceReferences } from "../../src/core/ai/evidence-references";
import {
	ConflictOutputSchema,
	getStructuredFailureMetadata,
	JudgeOutputSchema,
	StructuredOutputAdapter,
} from "../../src/core/ai/structured-output";
import { validateConflictEvidence } from "../../src/core/ask-graph/evidence-conflict";

type Adapter = Parameters<typeof assessEvidenceWithMetadata>[0];
type Input = Parameters<typeof assessEvidenceWithMetadata>[1];
const uuid = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa3333";
const truncatedUuid = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa333";
const otherUuid = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbb9999";
const sufficiency = { attempts: 2, durationMs: 12.25 };
const refusalReview = { attempts: 1, durationMs: 3.5 };
const conflict = { attempts: 3, durationMs: 8.75 };
const judgeOutput = {
	sufficient: true,
	action: "generate" as const,
	reason: "covered",
	evidence_ids: ["e1"],
};
const refusalOutput = {
	sufficient: false,
	action: "refuse" as const,
	reason: "missing",
	evidence_ids: [],
};
const input: Input = {
	question: "requirement?",
	query_type: "fact",
	attempts: 1,
	citations: [
		{ id: uuid, doc_id: "doc", text: "first provision" },
		{ id: otherUuid, doc_id: "doc", text: "second provision" },
	],
};
const reviewInput: Input = {
	...input,
	resolvedDocumentId: "doc",
	requirements: {
		granularity: "named_requirement",
		formal_name_required: false,
	},
};

function mockAdapter(overrides: Partial<Adapter> = {}) {
	const calls: string[] = [];
	const implementations: Adapter = {
		judgeWithMetadata: async () => ({
			output: judgeOutput,
			metadata: { ...sufficiency, inputTokens: 42 },
		}),
		reviewRefusalWithMetadata: async () => ({
			output: {
				missing_requirements: [],
				excerpts: [{ evidence_id: "e1", quote: "first provision" }],
			},
			metadata: refusalReview,
		}),
		checkConflictWithMetadata: async () => ({
			output: {
				comparison: "same",
				resolution: "consistent",
				conflict_evidence: [],
			},
			metadata: conflict,
		}),
		...overrides,
	};
	const adapter: Adapter = {
		judgeWithMetadata: async (...args) => {
			calls.push("judge");
			return implementations.judgeWithMetadata(...args);
		},
		reviewRefusalWithMetadata: async (...args) => {
			calls.push("refusal_review");
			return implementations.reviewRefusalWithMetadata(...args);
		},
		checkConflictWithMetadata: async (...args) => {
			calls.push("conflict");
			return implementations.checkConflictWithMetadata(...args);
		},
	};
	return { adapter, calls };
}

async function rejected(operation: Promise<unknown>): Promise<unknown> {
	let caught: unknown;
	await assert.rejects(operation, (error) => {
		caught = error;
		return true;
	});
	return caught;
}

function localFailure(
	error: unknown,
	validationCode: EvidenceAssessmentFailureMetadata["validationCode"],
	stage: EvidenceAssessmentFailureMetadata["stage"],
	completed: EvidenceAssessmentFailureMetadata["completed"],
) {
	assert.ok(error instanceof EvidenceAssessmentValidationError);
	assert.equal(error.validationCode, validationCode);
	assert.deepEqual(getEvidenceAssessmentFailureMetadata(error), {
		source: "evidence_validation",
		stage,
		validationCode,
		completed,
	});
	assert.equal(getStructuredFailureMetadata(error), undefined);
	assert.doesNotMatch(
		JSON.stringify(getEvidenceAssessmentFailureMetadata(error)),
		/aaaaaaaa|first provision|requirement\?|issues|inputTokens/,
	);
}

test("selected IDs distinguish empty, unknown aliases and ambiguous canonical sources", async () => {
	for (const [ids, citations, code] of [
		[[], input.citations, "selected_ids_empty"],
		[["e99"], input.citations, "selected_ids_unknown"],
		[[uuid], input.citations, "selected_ids_unknown"],
		[[truncatedUuid], input.citations, "selected_ids_unknown"],
		[["e01"], input.citations, "selected_ids_unknown"],
		[
			["e1"],
			[input.citations[0], { ...(input.citations[0] as object) }],
			"selected_ids_ambiguous",
		],
	] as const) {
		const { adapter, calls } = mockAdapter({
			judgeWithMetadata: async () => ({
				output: { ...judgeOutput, evidence_ids: [...ids] },
				metadata: sufficiency,
			}),
		});
		const error = await rejected(
			assessEvidenceWithMetadata(adapter, {
				...input,
				citations: [...citations],
			}),
		);
		localFailure(error, code, "selected_ids", { sufficiency });
		assert.deepEqual(calls, ["judge"]);
	}
});

test("conflict schema, source, quote and normalized duplicate failures retain both stages", async () => {
	for (const [excerpts, code] of [
		[[{ quote: "first provision" }], "conflict_schema"],
		[
			Array.from({ length: 7 }, () => ({
				evidence_id: "e1",
				quote: "first provision",
			})),
			"conflict_schema",
		],
		[
			[{ evidence_id: "e99", quote: "first provision" }],
			"conflict_unknown_source",
		],
		[
			[{ evidence_id: uuid, quote: "first provision" }],
			"conflict_unknown_source",
		],
		[[{ evidence_id: "e1", quote: "fabricated" }], "conflict_quote_mismatch"],
		[
			[
				{ evidence_id: "e1", quote: "first provision" },
				{ evidence_id: "e1", quote: " first\n provision " },
			],
			"conflict_duplicate_quote",
		],
	] as const) {
		const { adapter, calls } = mockAdapter({
			checkConflictWithMetadata: async () => ({
				output: {
					comparison: "different",
					resolution: "conflict",
					conflict_evidence: excerpts as unknown as {
						evidence_id: string;
						quote: string;
					}[],
				},
				metadata: conflict,
			}),
		});
		const error = await rejected(assessEvidenceWithMetadata(adapter, input));
		localFailure(error, code, "conflict_provenance", { sufficiency, conflict });
		assert.deepEqual(calls, ["judge", "conflict"]);
	}
	for (const citations of [
		[
			input.citations[0],
			{ id: otherUuid, doc_id: "other", text: "second provision" },
		],
		[...input.citations, { ...(input.citations[1] as object) }],
	]) {
		const { adapter } = mockAdapter({
			checkConflictWithMetadata: async () => ({
				output: {
					comparison: "different",
					resolution: "conflict",
					conflict_evidence: [{ evidence_id: "e2", quote: "second provision" }],
				},
				metadata: conflict,
			}),
		});
		localFailure(
			await rejected(
				assessEvidenceWithMetadata(adapter, { ...input, citations }),
			),
			"conflict_unknown_source",
			"conflict_provenance",
			{ sufficiency, conflict },
		);
	}
});

test("provenance validator uses typed errors without retaining Zod issues", () => {
	assert.throws(
		() => validateConflictEvidence([{ quote: "private" }], []),
		(error) => {
			assert.ok(error instanceof EvidenceAssessmentValidationError);
			assert.equal(error.validationCode, "conflict_schema");
			assert.equal("issues" in error, false);
			assert.equal("cause" in error, false);
			return true;
		},
	);
});

test("two individually legal outputs cannot merge into more than six canonical sources", async () => {
	const citations = Array.from({ length: 7 }, (_, i) => ({
		id: `canonical-${i}`,
		text: `quote-${i}`,
	}));
	const judged = JudgeOutputSchema.parse({
		...judgeOutput,
		evidence_ids: ["e1", "e2", "e3", "e4", "e5", "e6"],
	});
	const checked = ConflictOutputSchema.parse({
		comparison: "different",
		resolution: "conflict",
		conflict_evidence: [
			{ evidence_id: "e6", quote: "quote-5" },
			{ evidence_id: "e7", quote: "quote-6" },
		],
	});
	const { adapter, calls } = mockAdapter({
		judgeWithMetadata: async () => ({ output: judged, metadata: sufficiency }),
		checkConflictWithMetadata: async () => ({
			output: checked,
			metadata: conflict,
		}),
	});
	localFailure(
		await rejected(
			assessEvidenceWithMetadata(adapter, { ...input, citations }),
		),
		"source_count_exceeded",
		"source_count",
		{ sufficiency, conflict },
	);
	assert.deepEqual(calls, ["judge", "conflict"]);
});

test("second-stage structured failures retain the exact request sidecar and completed sufficiency", async () => {
	for (const stage of ["conflict", "refusal_review"] as const) {
		const original = new APICallError({
			message: "private provider body",
			url: "https://provider.invalid",
			requestBodyValues: {},
			statusCode: 401,
			isRetryable: false,
		});
		let executions = 0;
		const structured = new StructuredOutputAdapter(
			{} as LanguageModel,
			async () => {
				executions++;
				throw original;
			},
			{ maxAttempts: 3 },
		);
		const { adapter, calls } = mockAdapter({
			judgeWithMetadata: async () => ({
				output: stage === "conflict" ? judgeOutput : refusalOutput,
				metadata: sufficiency,
			}),
			...(stage === "conflict"
				? {
						checkConflictWithMetadata:
							structured.checkConflictWithMetadata.bind(structured),
					}
				: {
						reviewRefusalWithMetadata:
							structured.reviewRefusalWithMetadata.bind(structured),
					}),
		});
		const error = await rejected(
			assessEvidenceWithMetadata(adapter, reviewInput),
		);
		assert.equal(error, original);
		const metadata = getEvidenceAssessmentFailureMetadata(error);
		assert.ok(metadata);
		assert.equal(metadata.source, "structured_request");
		assert.equal(metadata.stage, stage);
		assert.deepEqual(metadata.completed, { sufficiency });
		assert.equal(metadata.request, getStructuredFailureMetadata(error));
		assert.equal(metadata.request?.kind, stage);
		assert.equal(metadata.request?.attempts, 1);
		assert.equal(metadata.validationCode, undefined);
		assert.doesNotMatch(
			JSON.stringify(metadata),
			/private|provider.invalid|issues/,
		);
		assert.deepEqual(calls, ["judge", stage]);
		assert.equal(executions, 1);
	}
});

test("unknown exceptions preserve identity and never infer provider statistics from their message", async () => {
	for (const stage of ["judge", "conflict", "refusal_review"] as const) {
		const original = Object.freeze(
			new Error("Invalid selected evidence; provider 401 timeout"),
		);
		const fail = async (): Promise<never> => {
			throw original;
		};
		const { adapter } = mockAdapter({
			judgeWithMetadata:
				stage === "judge"
					? fail
					: async () => ({
							output: stage === "conflict" ? judgeOutput : refusalOutput,
							metadata: sufficiency,
						}),
			...(stage === "conflict" ? { checkConflictWithMetadata: fail } : {}),
			...(stage === "refusal_review"
				? { reviewRefusalWithMetadata: fail }
				: {}),
		});
		const error = await rejected(
			assessEvidenceWithMetadata(adapter, reviewInput),
		);
		assert.equal(error, original);
		assert.deepEqual(getEvidenceAssessmentFailureMetadata(error), {
			source: "unknown",
			stage,
			completed: stage === "judge" ? {} : { sufficiency },
		});
		assert.equal(getStructuredFailureMetadata(error), undefined);
	}
	for (const value of [null, undefined, "failure", 1, new Error("untagged")])
		assert.equal(getEvidenceAssessmentFailureMetadata(value), undefined);
});

test("abort, admission and authorization exceptions keep their original identity without request statistics", async () => {
	for (const original of [
		new DOMException("aborted", "AbortError"),
		new AiConcurrencyOverloadedError(),
		new AiConcurrencyWaitTimeoutError(10),
		new Error("authorization revoked"),
	]) {
		let executions = 0;
		const structured = new StructuredOutputAdapter(
			{} as LanguageModel,
			async () => {
				executions++;
				throw new Error("must not execute");
			},
		);
		const { adapter } = mockAdapter({
			checkConflictWithMetadata:
				structured.checkConflictWithMetadata.bind(structured),
		});
		const error = await rejected(
			assessEvidenceWithMetadata(adapter, input, {
				beforeRequest: async () => {
					throw original;
				},
			}),
		);
		assert.equal(error, original);
		assert.deepEqual(getEvidenceAssessmentFailureMetadata(error), {
			source: "unknown",
			stage: "conflict",
			completed: { sufficiency },
		});
		assert.equal(executions, 0);
	}
});

test("comparison and summary retain early returns while decoding valid selected references", async () => {
	for (const query_type of ["compare", "summary"]) {
		for (const evidence_ids of [[], ["e2"]]) {
			const { adapter, calls } = mockAdapter({
				judgeWithMetadata: async () => ({
					output: { ...judgeOutput, evidence_ids },
					metadata: sufficiency,
				}),
			});
			const result = await assessEvidenceWithMetadata(adapter, {
				...input,
				query_type,
			});
			assert.deepEqual(
				result.output.evidence_ids,
				evidence_ids.length ? [otherUuid] : [],
			);
			assert.equal(result.output.evidence_resolution, "not_checked");
			assert.equal(result.output.judge_conflict_attempts, 0);
			assert.deepEqual(result.metadata, sufficiency);
			assert.deepEqual(calls, ["judge"]);
		}
	}
});

test("UUIDs with repeated tail characters round-trip only through short references without mutating candidates", async () => {
	const citations = input.citations.map((item) =>
		Object.freeze({ ...(item as object) }),
	);
	const before = structuredClone(citations);
	const structured = new StructuredOutputAdapter(
		{} as LanguageModel,
		async (request) => {
			const serialized = String(request.messages[0].content);
			assert.ok(!serialized.includes(uuid));
			assert.ok(!serialized.includes(otherUuid));
			assert.ok(serialized.includes('"id":"e1"'));
			assert.ok(serialized.includes('"id":"e2"'));
			assert.ok(serialized.includes('"doc_id":"doc"'));
			if (request.schemaName === "judge") return judgeOutput;
			const sent = JSON.parse(serialized);
			assert.deepEqual(sent.evidence_ids, ["e1"]);
			return {
				comparison: "different",
				resolution: "conflict",
				conflict_evidence: [
					{ evidence_id: "e1", quote: "first provision" },
					{ evidence_id: "e2", quote: "second provision" },
				],
			};
		},
	);
	const result = await assessEvidenceWithMetadata(structured, {
		...input,
		citations,
	});
	assert.deepEqual(result.output.evidence_ids, [uuid, otherUuid]);
	assert.deepEqual(result.output.conflict_evidence, [
		{ evidence_id: uuid, quote: "first provision" },
		{ evidence_id: otherUuid, quote: "second provision" },
	]);
	assert.deepEqual(citations, before);
	const references = createEvidenceReferences(citations);
	assert.equal(references.decodeId(uuid), undefined);
	assert.equal(references.decodeId(truncatedUuid), undefined);
	assert.equal(references.decodeId("e1"), uuid);
	assert.notEqual(references.encodeCitations(citations)[0], citations[0]);
});

test("request maps are isolated even for overlapping concurrent assessments", async () => {
	const { adapter } = mockAdapter();
	const results = await Promise.all(
		[uuid, otherUuid].map((id) =>
			assessEvidenceWithMetadata(adapter, {
				...input,
				citations: [{ id, text: "first provision" }],
			}),
		),
	);
	assert.deepEqual(
		results.map((result) => result.output.evidence_ids),
		[[uuid], [otherUuid]],
	);
	const references = createEvidenceReferences([{ id: uuid }]);
	assert.equal(references.decodeId("e2"), undefined);
	assert.throws(
		() => references.encodeId(otherUuid),
		EvidenceAssessmentValidationError,
	);
});

test("conflict candidate subsets retain original numbering and decode before strict provenance checks", async () => {
	const citations = [
		{ id: "outside", doc_id: "other", text: "outside" },
		...input.citations,
	];
	const { adapter } = mockAdapter({
		judgeWithMetadata: async (sent) => {
			assert.deepEqual(
				sent.citations.map((item) => (item as { id: string }).id),
				["e1", "e2", "e3"],
			);
			return {
				output: { ...judgeOutput, evidence_ids: ["e2"] },
				metadata: sufficiency,
			};
		},
		checkConflictWithMetadata: async (sent) => {
			assert.deepEqual(
				sent.citations.map((item) => (item as { id: string }).id),
				["e2", "e3"],
			);
			assert.deepEqual(sent.evidence_ids, ["e2"]);
			return {
				output: {
					comparison: "different",
					resolution: "conflict",
					conflict_evidence: [{ evidence_id: "e3", quote: "second provision" }],
				},
				metadata: conflict,
			};
		},
	});
	const result = await assessEvidenceWithMetadata(adapter, {
		...input,
		citations,
	});
	assert.deepEqual(result.output.evidence_ids, [uuid, otherUuid]);
});

test("refusal review shares the judge/conflict mapping and retains all completed stages on local failure", async () => {
	for (const failConflict of [false, true]) {
		const seen: string[] = [];
		const assertCitations = (sent: { citations: unknown[] }) =>
			assert.deepEqual(
				sent.citations.map((item) => (item as { id: string }).id),
				["e1", "e2"],
			);
		const { adapter, calls } = mockAdapter({
			judgeWithMetadata: async (sent) => {
				assertCitations(sent);
				seen.push("judge");
				return { output: refusalOutput, metadata: sufficiency };
			},
			reviewRefusalWithMetadata: async (sent) => {
				assertCitations(sent);
				seen.push("review");
				return {
					output: {
						missing_requirements: [],
						excerpts: [{ evidence_id: "e2", quote: "second provision" }],
					},
					metadata: refusalReview,
				};
			},
			checkConflictWithMetadata: async (sent) => {
				assertCitations(sent);
				assert.deepEqual(sent.evidence_ids, ["e2"]);
				seen.push("conflict");
				return {
					output: {
						comparison: "different",
						resolution: "conflict",
						conflict_evidence: [
							{
								evidence_id: failConflict ? "e99" : "e1",
								quote: "first provision",
							},
						],
					},
					metadata: conflict,
				};
			},
		});
		const operation = assessEvidenceWithMetadata(adapter, reviewInput);
		if (failConflict)
			localFailure(
				await rejected(operation),
				"conflict_unknown_source",
				"conflict_provenance",
				{ sufficiency, refusalReview, conflict },
			);
		else {
			const result = await operation;
			assert.equal(result.output.judge_refusal_review, "recovered");
			assert.deepEqual(result.output.evidence_ids, [otherUuid, uuid]);
			assert.equal(result.metadata.attempts, 6);
			assert.equal(result.metadata.durationMs, 24.5);
		}
		assert.deepEqual(calls, ["judge", "refusal_review", "conflict"]);
		assert.deepEqual(seen, ["judge", "review", "conflict"]);
	}
});

test("refusal review unknown aliases, canonical passthrough and invalid quotes remain refusals", async () => {
	for (const excerpt of [
		{ evidence_id: "e99", quote: "first provision" },
		{ evidence_id: uuid, quote: "first provision" },
		{ evidence_id: "e1", quote: "fabricated" },
	]) {
		const { adapter, calls } = mockAdapter({
			judgeWithMetadata: async () => ({
				output: refusalOutput,
				metadata: sufficiency,
			}),
			reviewRefusalWithMetadata: async () => ({
				output: { missing_requirements: [], excerpts: [excerpt] },
				metadata: refusalReview,
			}),
		});
		const result = await assessEvidenceWithMetadata(adapter, reviewInput);
		assert.equal(result.output.action, "refuse");
		assert.equal(result.output.judge_refusal_review, "invalid_evidence");
		assert.deepEqual(result.output.evidence_ids, []);
		assert.deepEqual(calls, ["judge", "refusal_review"]);
	}
});
