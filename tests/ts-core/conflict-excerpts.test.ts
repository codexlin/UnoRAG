import assert from "node:assert/strict";
import test from "node:test";
import type { LanguageModel } from "ai";
import { createConflictExcerpts } from "../../src/core/ai/conflict-excerpts";
import { EvidenceAssessmentValidationError } from "../../src/core/ai/evidence-assessment-diagnostics";
import { ModelUsageCollector } from "../../src/core/ai/model-usage";
import {
	ConflictReviewOutputSchema,
	getStructuredFailureMetadata,
	StructuredOutputAdapter,
	StructuredOutputTimeoutError,
	StructuredOutputValidationError,
} from "../../src/core/ai/structured-output";
import { validateConflictEvidence } from "../../src/core/ask-graph/evidence-conflict";

test("conflict catalog preserves ordered original slices and source identity without duplicating raw text", () => {
	const text = `${"长段落😀（条件未变）。".repeat(120)}\nEnds here.`;
	const source = Object.freeze({
		id: "e4",
		text,
		body: "not a second evidence channel",
		snippet: "not a third evidence channel",
		doc_id: "doc",
		section_path: "第一条",
	});
	const catalog = createConflictExcerpts([source]);
	const projected = catalog.citations[0];
	assert.equal(projected.doc_id, "doc");
	assert.equal(projected.section_path, "第一条");
	assert.equal("text" in projected, false);
	assert.equal("body" in projected, false);
	assert.equal("snippet" in projected, false);
	assert.ok(projected.excerpts.length > 2);
	for (const excerpt of projected.excerpts) {
		assert.ok(excerpt.text.length <= 600);
		assert.ok(text.includes(excerpt.text));
		assert.ok(excerpt.text.isWellFormed());
		assert.deepEqual(catalog.resolve(excerpt.id), {
			evidence_id: "e4",
			quote: excerpt.text,
		});
	}
	assert.equal(
		projected.excerpts
			.map((item) => item.text)
			.join("")
			.replace(/\s/gu, ""),
		text.replace(/\s/gu, ""),
	);
	assert.equal(source.text, text);
});

test("unpunctuated text is covered without splitting surrogate pairs or inventing a truncation marker", () => {
	const text = `${"a".repeat(599)}😀${"x".repeat(750)}`;
	const catalog = createConflictExcerpts([{ id: "e1", text }]);
	const parts = catalog.citations[0].excerpts.map((part) => part.text);
	assert.equal(parts.join(""), text);
	assert.ok(parts.every((part) => part.length <= 600 && part.isWellFormed()));
});

test("missing and duplicate source identities fail closed and catalogs do not share state", () => {
	for (const sources of [
		[null],
		[{ id: "e1" }],
		[{ id: "e1", text: " \n " }],
		[
			{ id: "e1", text: "one" },
			{ id: "e1", text: "two" },
		],
	])
		assert.throws(
			() => createConflictExcerpts(sources),
			EvidenceAssessmentValidationError,
		);
	const a = createConflictExcerpts([{ id: "a", text: "first" }]);
	const b = createConflictExcerpts([{ id: "b", text: "second" }]);
	assert.equal(a.resolve("s1").quote, "first");
	assert.equal(b.resolve("s1").quote, "second");
	assert.throws(() => a.resolve("s2"), EvidenceAssessmentValidationError);
	a.resolve("s1").quote = "changed";
	assert.equal(a.resolve("s1").quote, "first");
});

test("model selects only short excerpt IDs; the server materializes exact authorized quotations", async () => {
	const citations = [
		{ id: "e1", text: "签署后12日付款。", doc_id: "d" },
		{ id: "e2", text: "签署后24日付款。", doc_id: "d" },
	];
	const usage = new ModelUsageCollector();
	const calls: string[] = [];
	const adapter = new StructuredOutputAdapter(
		{} as LanguageModel,
		async (request) => {
			calls.push(request.schemaName);
			const input = JSON.parse(String(request.messages[0].content));
			if (request.schemaName === "conflict_review") {
				assert.deepEqual(input.citations, [
					{ id: "v1", doc_id: "d", text: citations[0].text },
					{ id: "v2", doc_id: "d", text: citations[1].text },
				]);
				request.onUsage?.({
					inputTokens: 20,
					outputTokens: 1,
					totalTokens: 21,
				});
				return { incompatible: true };
			}
			assert.equal(request.schemaName, "conflict");
			assert.deepEqual(
				input.citations.map((c: { excerpts: unknown }) => c.excerpts),
				[
					[{ id: "s1", text: citations[0].text }],
					[{ id: "s2", text: citations[1].text }],
				],
			);
			request.onUsage?.({ inputTokens: 10, outputTokens: 2, totalTokens: 12 });
			return {
				comparison: "same condition, different deadlines",
				resolution: "conflict",
				conflict_evidence: ["s1", "s2"],
			};
		},
		{ usageRecorder: usage.record },
	);
	const result = await adapter.checkConflictWithMetadata({
		question: "付款期限？",
		citations,
		evidence_ids: ["e1"],
	});
	assert.deepEqual(
		result.output.conflict_evidence,
		citations.map((c) => ({ evidence_id: c.id, quote: c.text })),
	);
	assert.equal(
		validateConflictEvidence(
			result.output.conflict_evidence,
			citations as never,
		).length,
		2,
	);
	assert.equal(
		validateConflictEvidence(
			[{ evidence_id: "e1", quote: "补充条款约定为60日。" }],
			[
				{
					id: "e1",
					body: "主条款约定为30日。",
					parent_context: "主条款约定为30日。补充条款约定为60日。",
				},
			] as never,
		).length,
		1,
	);
	assert.deepEqual(calls, ["conflict", "conflict_review"]);
	assert.equal(result.metadata.attempts, 2);
	assert.equal(result.metadata.inputTokens, 30);
	assert.equal(result.metadata.outputTokens, 3);
	assert.equal(result.metadata.totalTokens, 33);
	assert.ok(result.metadata.conflictReview);
	assert.equal(result.metadata.conflictReview.confirmed, true);
	assert.equal(result.metadata.conflictReview.attempts, 1);
	assert.ok(result.metadata.conflictReview.durationMs >= 0);
	assert.ok(
		result.metadata.durationMs >= result.metadata.conflictReview.durationMs,
	);
	assert.deepEqual(
		usage.snapshot().calls.map(({ stage, status }) => ({ stage, status })),
		[
			{ stage: "conflict", status: "completed" },
			{ stage: "conflict", status: "completed" },
		],
	);
	assert.equal(usage.snapshot().totalTokens, 33);
});

test("conflict review is a strict boolean object without model-authored evidence or explanation", () => {
	const schema = ConflictReviewOutputSchema.toJSONSchema();
	assert.equal(schema.type, "object");
	assert.deepEqual(schema.required, ["incompatible"]);
	assert.deepEqual(Object.keys(schema.properties ?? {}), ["incompatible"]);
	assert.equal(schema.additionalProperties, false);
	for (const incompatible of [true, false])
		assert.deepEqual(ConflictReviewOutputSchema.parse({ incompatible }), {
			incompatible,
		});
	for (const invalid of [
		null,
		true,
		{},
		{ incompatible: "false" },
		{ incompatible: 1 },
		{ incompatible: true, explanation: "extra model prose" },
	])
		assert.equal(ConflictReviewOutputSchema.safeParse(invalid).success, false);
});

test("a rejected proposal clears conflict and reviews only exact proposed snippets with their own identities", async () => {
	const citations = [
		{
			id: "e1",
			doc_id: "doc-a",
			title: "Contract A",
			filename: "contract-a.txt",
			document_context: { title: "Contract A", identifiers: ["CONTRACT-A"] },
			section_path: "Definitions",
			preamble: "Initial service term",
			text: "The service starts on the stated date.",
		},
		{
			id: "e2",
			doc_id: "doc-a",
			section_path: "Agreement effectiveness",
			text: "The agreement becomes effective on signing.",
		},
		{ id: "e3", doc_id: "doc-b", text: "Unselected other-project provision." },
	];
	const before = structuredClone(citations);
	const calls: string[] = [];
	const adapter = new StructuredOutputAdapter(
		{} as LanguageModel,
		async (request) => {
			calls.push(request.schemaName);
			if (request.schemaName === "conflict")
				return {
					comparison: "untrusted proposal explanation",
					resolution: "conflict",
					conflict_evidence: ["s1", "s2"],
				};
			assert.equal(request.schemaName, "conflict_review");
			const sent = JSON.parse(String(request.messages[0].content));
			assert.deepEqual(sent, {
				question: "When does the service start?",
				citations: citations
					.slice(0, 2)
					.map(({ id: _id, ...source }, index) => ({
						...source,
						id: `v${index + 1}`,
					})),
			});
			assert.doesNotMatch(
				JSON.stringify(sent),
				/untrusted proposal|Unselected|doc-b/,
			);
			return { incompatible: false };
		},
	);
	const result = await adapter.checkConflictWithMetadata({
		question: "When does the service start?",
		query_type: "fact",
		citations,
		evidence_ids: ["e1"],
	});
	assert.deepEqual(calls, ["conflict", "conflict_review"]);
	assert.equal(result.output.resolution, "consistent");
	assert.deepEqual(result.output.conflict_evidence, []);
	assert.notEqual(result.output.comparison, "untrusted proposal explanation");
	assert.equal(result.metadata.attempts, 2);
	assert.ok(result.metadata.conflictReview);
	assert.equal(result.metadata.conflictReview.confirmed, false);
	assert.equal(result.metadata.conflictReview.attempts, 1);
	assert.deepEqual(citations, before);
});

test("consistent, scoped and precedence resolutions do not add review requests", async () => {
	for (const resolution of ["consistent", "scoped", "precedence"] as const) {
		const calls: string[] = [];
		const adapter = new StructuredOutputAdapter(
			{} as LanguageModel,
			async (request) => {
				calls.push(request.schemaName);
				assert.equal(request.schemaName, "conflict");
				return { comparison: "compatible", resolution, conflict_evidence: [] };
			},
		);
		const result = await adapter.checkConflictWithMetadata({
			question: "Term?",
			citations: [{ id: "e1", text: "One provision." }],
			evidence_ids: ["e1"],
		});
		assert.deepEqual(calls, ["conflict"]);
		assert.equal(result.output.resolution, resolution);
		assert.equal(result.metadata.attempts, 1);
		assert.equal(result.metadata.conflictReview, undefined);
	}
});

test("reauthorization failure before conflict review prevents the extra model call", async () => {
	const original = new Error("authorization revoked before review");
	const usage = new ModelUsageCollector();
	const calls: string[] = [];
	let checkpoints = 0;
	const adapter = new StructuredOutputAdapter(
		{} as LanguageModel,
		async (request) => {
			calls.push(request.schemaName);
			return {
				comparison: "different",
				resolution: "conflict",
				conflict_evidence: ["s1", "s2"],
			};
		},
		{ maxAttempts: 3, usageRecorder: usage.record },
	);
	await assert.rejects(
		adapter.checkConflictWithMetadata(
			{
				question: "Term?",
				citations: [
					{ id: "e1", text: "12 days." },
					{ id: "e2", text: "24 days." },
				],
				evidence_ids: ["e1"],
			},
			{
				beforeRequest: async () => {
					if (++checkpoints === 2) throw original;
				},
			},
		),
		(error) => error === original,
	);
	assert.equal(checkpoints, 2);
	assert.deepEqual(calls, ["conflict"]);
	assert.equal(getStructuredFailureMetadata(original), undefined);
	assert.equal(usage.snapshot().calls.length, 1);
	assert.equal(usage.snapshot().calls[0].status, "completed");
});

test("invalid conflict reviews fail technically after one attempt without retrying the conflict proposal", async () => {
	for (const invalid of [
		null,
		{},
		{ incompatible: "true" },
		{ incompatible: true, quote: "fabricated" },
	]) {
		const usage = new ModelUsageCollector();
		const calls: string[] = [];
		const adapter = new StructuredOutputAdapter(
			{} as LanguageModel,
			async (request) => {
				calls.push(request.schemaName);
				if (request.schemaName === "conflict_review") return invalid;
				return {
					comparison: "different",
					resolution: "conflict",
					conflict_evidence: ["s1", "s2"],
				};
			},
			{ maxAttempts: 3, usageRecorder: usage.record },
		);
		await assert.rejects(
			adapter.checkConflictWithMetadata({
				question: "Term?",
				citations: [
					{ id: "e1", text: "12 days." },
					{ id: "e2", text: "24 days." },
				],
				evidence_ids: ["e1"],
			}),
			(error) => {
				assert.ok(error instanceof StructuredOutputValidationError);
				const metadata = getStructuredFailureMetadata(error);
				assert.ok(metadata);
				assert.equal(metadata.kind, "conflict_review");
				assert.equal(metadata.attempts, 1);
				assert.equal(metadata.maxAttempts, 1);
				assert.equal(metadata.category, "invalid_output");
				return true;
			},
		);
		assert.deepEqual(calls, ["conflict", "conflict_review"]);
		assert.deepEqual(
			usage.snapshot().calls.map(({ stage, status }) => ({ stage, status })),
			[
				{ stage: "conflict", status: "completed" },
				{ stage: "conflict", status: "failed" },
			],
		);
	}
});

test("normalized duplicate quotes fail provenance validation before conflict review", async () => {
	const calls: string[] = [];
	const usage = new ModelUsageCollector();
	const adapter = new StructuredOutputAdapter(
		{} as LanguageModel,
		async (request) => {
			calls.push(request.schemaName);
			return {
				comparison: "proposed duplicate",
				resolution: "conflict",
				conflict_evidence: ["s1", "s2"],
			};
		},
		{ usageRecorder: usage.record },
	);
	await assert.rejects(
		adapter.checkConflictWithMetadata({
			question: "Term?",
			citations: [
				{ id: "e1", text: "The term is twelve days." },
				{ id: "e2", text: "The term is   twelve days." },
			],
			evidence_ids: ["e1"],
		}),
		(error) => {
			assert.ok(error instanceof EvidenceAssessmentValidationError);
			assert.equal(error.validationCode, "conflict_duplicate_quote");
			return true;
		},
	);
	assert.deepEqual(calls, ["conflict"]);
	assert.equal(usage.snapshot().calls.length, 1);
	assert.equal(usage.snapshot().calls[0].status, "completed");
});

test("conflict review timeout and abort fail closed without repeating either model request", async () => {
	for (const outcome of ["timeout", "abort"] as const) {
		const controller = new AbortController();
		const original = new Error("review cancelled");
		const calls: string[] = [];
		const usage = new ModelUsageCollector();
		let checkpoints = 0;
		const adapter = new StructuredOutputAdapter(
			{} as LanguageModel,
			async (request) => {
				calls.push(request.schemaName);
				if (request.schemaName === "conflict_review") {
					if (outcome === "timeout") return new Promise<never>(() => {});
					controller.abort(original);
					return { incompatible: true };
				}
				return {
					comparison: "different",
					resolution: "conflict",
					conflict_evidence: ["s1", "s2"],
				};
			},
			{ timeoutMs: 10, maxAttempts: 3, usageRecorder: usage.record },
		);
		await assert.rejects(
			adapter.checkConflictWithMetadata(
				{
					question: "Term?",
					citations: [
						{ id: "e1", text: "12 days." },
						{ id: "e2", text: "24 days." },
					],
					evidence_ids: ["e1"],
				},
				{
					abortSignal: controller.signal,
					beforeRequest: async () => {
						checkpoints++;
					},
				},
			),
			(error) => {
				if (outcome === "abort") {
					assert.equal(error, original);
					assert.equal(getStructuredFailureMetadata(error), undefined);
				} else {
					assert.ok(error instanceof StructuredOutputTimeoutError);
					assert.equal(error.kind, "conflict_review");
					const metadata = getStructuredFailureMetadata(error);
					assert.ok(metadata);
					assert.equal(metadata.kind, "conflict_review");
					assert.equal(metadata.category, "timeout");
					assert.equal(metadata.attempts, 1);
					assert.equal(metadata.maxAttempts, 1);
				}
				return true;
			},
		);
		assert.equal(checkpoints, 2);
		assert.deepEqual(calls, ["conflict", "conflict_review"]);
		assert.deepEqual(
			usage.snapshot().calls.map(({ stage, status }) => ({ stage, status })),
			[
				{ stage: "conflict", status: "completed" },
				{
					stage: "conflict",
					status: outcome === "abort" ? "cancelled" : "failed",
				},
			],
		);
	}
});

test("foreign, repeated, quoted and over-limit model references are rejected, never fuzzy-resolved", async () => {
	for (const selection of [
		["s99"],
		["e1"],
		["s1", "s1"],
		[{ evidence_id: "e1", quote: "fabricated" }],
		Array(7).fill("s1"),
	]) {
		const adapter = new StructuredOutputAdapter(
			{} as LanguageModel,
			async () => ({
				comparison: "different",
				resolution: "conflict",
				conflict_evidence: selection,
			}),
			{ maxAttempts: 1 },
		);
		await assert.rejects(
			adapter.checkConflictWithMetadata({
				question: "期限？",
				citations: [{ id: "e1", text: "12日" }],
				evidence_ids: ["e1"],
			}),
			(error) => {
				assert.ok(error instanceof StructuredOutputValidationError);
				assert.equal(
					getStructuredFailureMetadata(error)?.category,
					"invalid_output",
				);
				return true;
			},
		);
	}
});
