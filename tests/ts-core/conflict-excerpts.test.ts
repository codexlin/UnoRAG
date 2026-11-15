import assert from "node:assert/strict";
import test from "node:test";
import type { LanguageModel } from "ai";
import { createConflictExcerpts } from "../../src/core/ai/conflict-excerpts";
import { EvidenceAssessmentValidationError } from "../../src/core/ai/evidence-assessment-diagnostics";
import {
	getStructuredFailureMetadata,
	StructuredOutputAdapter,
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
	const adapter = new StructuredOutputAdapter(
		{} as LanguageModel,
		async (request) => {
			const input = JSON.parse(String(request.messages[0].content));
			assert.deepEqual(
				input.citations.map((c: { excerpts: unknown }) => c.excerpts),
				[
					[{ id: "s1", text: citations[0].text }],
					[{ id: "s2", text: citations[1].text }],
				],
			);
			return {
				comparison: "same condition, different deadlines",
				resolution: "conflict",
				conflict_evidence: ["s1", "s2"],
			};
		},
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
	assert.equal(result.metadata.attempts, 1);
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
