import assert from "node:assert/strict";
import test from "node:test";
import { EvidenceAssessmentValidationError } from "../../src/core/ai/evidence-assessment-diagnostics";
import { boundedJudgeEvidenceText } from "../../src/core/ask-graph/comparison-evidence";
import { validateConflictEvidence } from "../../src/core/ask-graph/evidence-conflict";

const limit = 2_400;
const sourceId = "canonical-source";

for (const length of [limit - 1, limit, limit + 1, limit * 3]) {
	test(`Judge text of ${length} characters remains an unchanged contiguous source substring`, () => {
		const content = `${"x".repeat(length - 1)}.`;
		const original = ` \n${content}\t `;
		const projected = boundedJudgeEvidenceText(original);
		assert.equal(projected, content.slice(0, limit));
		assert.ok(original.includes(projected));
		assert.ok(projected.length <= limit);
	});
}

test("a quote ending at the long-text boundary validates against both the projection and original source", () => {
	const provision =
		"Payment is due within 12 days.\nLate payment requires review.";
	const prefix = "x".repeat(limit - provision.length) + provision;
	const original = `\n${prefix}\nOmitted source content.${"y".repeat(limit)}\t`;
	const projected = boundedJudgeEvidenceText(original);
	assert.equal(projected, prefix);
	const verified = validateConflictEvidence(
		[{ evidence_id: "e3", quote: provision }],
		[{ id: sourceId, text: projected }],
		(reference) => (reference === "e3" ? sourceId : undefined),
	);
	assert.deepEqual(verified, [{ evidence_id: sourceId, quote: provision }]);
	assert.deepEqual(
		validateConflictEvidence(verified, [{ id: sourceId, body: original }]),
		verified,
	);
});

for (const suffix of ["\u2026", "..."]) {
	test(`a fabricated ${JSON.stringify(suffix)} at the truncation boundary fails both provenance checks`, () => {
		const original = `${"x".repeat(limit - 10)}12 days.${"y".repeat(limit)}`;
		const projected = boundedJudgeEvidenceText(original);
		const quote = original.slice(0, limit).slice(-32) + suffix;
		for (const source of [
			{ id: sourceId, text: projected },
			{ id: sourceId, body: original },
		]) {
			assert.throws(
				() =>
					validateConflictEvidence(
						[{ evidence_id: sourceId, quote }],
						[source],
					),
				(error) => {
					assert.ok(error instanceof EvidenceAssessmentValidationError);
					assert.equal(error.validationCode, "conflict_quote_mismatch");
					return true;
				},
			);
		}
	});
}

test("an ellipsis present in the original source remains valid at the projection boundary", () => {
	const quote = "First provision\u2026second provision.";
	const prefix = "x".repeat(limit - quote.length) + quote;
	const original = `${prefix}More source content.`;
	const projected = boundedJudgeEvidenceText(original);
	assert.equal(projected, prefix);
	const excerpts = [{ evidence_id: sourceId, quote }];
	assert.deepEqual(
		validateConflictEvidence(excerpts, [{ id: sourceId, text: projected }]),
		validateConflictEvidence(excerpts, [{ id: sourceId, body: original }]),
	);
});

test("Judge text preserves interior whitespace and keeps non-text input empty", () => {
	assert.equal(
		boundedJudgeEvidenceText(" \nfirst\t\nsecond\r\n "),
		"first\t\nsecond",
	);
	for (const value of [undefined, null, 42, {}, " \n\t"]) {
		assert.equal(boundedJudgeEvidenceText(value), "");
	}
});
