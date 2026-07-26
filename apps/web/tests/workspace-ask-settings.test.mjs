import assert from "node:assert/strict";
import test from "node:test";
import {
	resolveDocumentPolicy,
	validateDocumentProfile,
} from "../src/lib/server/document-policy.mjs";
import {
	ASK_INTERNAL_DEFAULTS,
	mergeAskPatch,
	migrateLegacyAskToPublic,
	PUBLIC_ASK_DEFAULTS,
	resolveAskPolicy,
	sanitizeStoredAsk,
	validateAskPatch,
} from "../src/lib/server/workspace-ask-settings.mjs";
import { canManageMembers } from "../src/lib/server/workspace-permissions.mjs";

test("public defaults match balanced → internal ASK defaults", () => {
	const resolved = resolveAskPolicy(PUBLIC_ASK_DEFAULTS);
	assert.equal(resolved.retrieve_top_k, ASK_INTERNAL_DEFAULTS.retrieve_top_k);
	assert.equal(
		resolved.answer_min_score,
		ASK_INTERNAL_DEFAULTS.answer_min_score,
	);
	assert.equal(resolved.hybrid_enabled, ASK_INTERNAL_DEFAULTS.hybrid_enabled);
	assert.equal(resolved.rerank_enabled, ASK_INTERNAL_DEFAULTS.rerank_enabled);
	assert.equal(
		resolved.citation_adjudicate_enabled,
		ASK_INTERNAL_DEFAULTS.citation_adjudicate_enabled,
	);
	assert.equal(resolved.session_memory_enabled, true);
});

test("only owner and admin can manage workspace settings", () => {
	assert.equal(canManageMembers({ role: "viewer" }), false);
	assert.equal(canManageMembers({ role: "editor" }), false);
	assert.equal(canManageMembers({ role: "admin" }), true);
	assert.equal(canManageMembers({ role: "owner" }), true);
});

test("validateAskPatch accepts public enums", () => {
	const result = validateAskPatch({
		answer_profile: "precise",
		retrieval_enhancement: "on",
		evidence_requirement: "strict",
		session_memory_enabled: false,
	});
	assert.equal(result.ok, true);
	assert.deepEqual(result.patch, {
		answer_profile: "precise",
		retrieval_enhancement: "on",
		evidence_requirement: "strict",
		session_memory_enabled: false,
	});
});

test("validateAskPatch rejects algorithm knobs and unknown keys", () => {
	assert.equal(validateAskPatch({ retrieve_top_k: 8 }).ok, false);
	assert.equal(validateAskPatch({ hybrid_enabled: true }).ok, false);
	assert.equal(validateAskPatch({ answer_profile: "turbo" }).ok, false);
	assert.equal(validateAskPatch({ unknown_key: true }).ok, false);
	assert.equal(validateAskPatch(null).ok, false);
});

test("legacy numeric settings migrate to closest profiles", () => {
	assert.deepEqual(
		migrateLegacyAskToPublic({
			retrieve_top_k: 4,
			answer_min_score: 0.55,
			hybrid_enabled: true,
			rerank_enabled: true,
			citation_adjudicate_absolute_floor: 0.45,
		}),
		{
			answer_profile: "precise",
			retrieval_enhancement: "on",
			session_memory_enabled: true,
			evidence_requirement: "strict",
		},
	);
	assert.equal(
		sanitizeStoredAsk({ retrieve_top_k: 10, answer_min_score: 0.2 })
			.answer_profile,
		"exploratory",
	);
});

test("evidence_requirement takes stricter refusal vs answer_profile", () => {
	const exploratoryRelaxed = resolveAskPolicy({
		answer_profile: "exploratory",
		retrieval_enhancement: "off",
		session_memory_enabled: true,
		evidence_requirement: "relaxed",
	});
	const exploratoryStrict = resolveAskPolicy({
		answer_profile: "exploratory",
		retrieval_enhancement: "off",
		session_memory_enabled: true,
		evidence_requirement: "strict",
	});
	assert.ok(
		exploratoryStrict.answer_min_score > exploratoryRelaxed.answer_min_score,
	);
	assert.equal(exploratoryStrict.citation_adjudicate_enabled, true);
	assert.ok(exploratoryStrict.answer_min_score >= 0.5);

	const preciseRelaxed = resolveAskPolicy({
		answer_profile: "precise",
		retrieval_enhancement: "off",
		session_memory_enabled: true,
		evidence_requirement: "relaxed",
	});
	// precise base 0.55 softened by -0.1 → 0.45, still above relaxed floor 0
	assert.ok(preciseRelaxed.answer_min_score >= 0.45);
});

test("retrieval_enhancement off/on/auto resolve hybrid+rerank", () => {
	const off = resolveAskPolicy({
		...PUBLIC_ASK_DEFAULTS,
		retrieval_enhancement: "off",
	});
	assert.equal(off.hybrid_enabled, false);
	assert.equal(off.rerank_enabled, false);

	const on = resolveAskPolicy({
		...PUBLIC_ASK_DEFAULTS,
		retrieval_enhancement: "on",
	});
	assert.equal(on.hybrid_enabled, true);
	assert.equal(on.rerank_enabled, true);

	const autoDefault = resolveAskPolicy({
		...PUBLIC_ASK_DEFAULTS,
		retrieval_enhancement: "auto",
	});
	assert.equal(autoDefault.hybrid_enabled, false);
	assert.equal(autoDefault.rerank_enabled, false);

	const autoLookup = resolveAskPolicy(
		{ ...PUBLIC_ASK_DEFAULTS, retrieval_enhancement: "auto" },
		{ question: "合同编号 HT-2024-001 的金额是多少？" },
	);
	assert.equal(autoLookup.hybrid_enabled, true);
	assert.equal(autoLookup.rerank_enabled, true);
});

test("null patch key resets to public default", () => {
	const merged = mergeAskPatch(
		{ answer_profile: "precise", retrieval_enhancement: "on" },
		{ answer_profile: null },
	);
	assert.equal(merged.answer_profile, "balanced");
	assert.equal(merged.retrieval_enhancement, "on");
});

test("document_profile maps to internal chunk profiles", () => {
	assert.equal(validateDocumentProfile("table_heavy").ok, true);
	assert.equal(validateDocumentProfile("nope").ok, false);
	assert.equal(
		resolveDocumentPolicy({ documentProfile: "regulatory" }).chunk_profile,
		"precise",
	);
	assert.equal(
		resolveDocumentPolicy({ documentProfile: "narrative" }).chunk_profile,
		"narrative",
	);
	assert.equal(
		resolveDocumentPolicy({ scanHandling: "force_ocr" }).ocr_enabled,
		true,
	);
	assert.equal(
		resolveDocumentPolicy({ scanHandling: "auto" }).ocr_enabled,
		null,
	);
	const disabled = resolveDocumentPolicy({ scanHandling: "disabled" });
	assert.equal(disabled.ocr_enabled, false);
	assert.equal(disabled.enhanced_parser_allowed, false);
	assert.equal(
		resolveDocumentPolicy({ scanHandling: "force_ocr" })
			.enhanced_parser_allowed,
		true,
	);
});
