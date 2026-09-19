import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
	resolveDocumentPolicy,
	validateDocumentProfile,
} from "../src/lib/server/document-policy.mjs";
import {
	ASK_INTERNAL_DEFAULTS,
	mergeAskPatch,
	PUBLIC_ASK_DEFAULTS,
	resolveAskPolicy,
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

test("legacy Ask settings migrate once and preserve their previous value", () => {
	const migration = readFileSync(
		new URL("../drizzle/0026_migrate_ask_profiles.sql", import.meta.url),
		"utf8",
	);
	assert.match(migration, /WITH legacy_settings AS/);
	assert.match(migration, /jsonb_build_object\(/);
	assert.match(migration, /'answer_profile'/);
	assert.match(migration, /'retrieval_enhancement'/);
	assert.match(migration, /'evidence_requirement'/);
	assert.match(
		migration,
		/ask_previous = COALESCE\(settings\.ask_previous, mapped\.previous_ask\)/,
	);
	assert.match(migration, /policy_version = settings\.policy_version \+ 1/);
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

	for (const question of [
		"项目组诊断出的第一个主要问题是什么？具体表现如何？",
		"发生概率最高的风险是哪一类？概率区间和影响程度如何？",
		"图4中总预算最高的部门是哪个？其基础设施投入占比多少？",
	]) {
		const autoSensitive = resolveAskPolicy(
			{ ...PUBLIC_ASK_DEFAULTS, retrieval_enhancement: "auto" },
			{ question },
		);
		assert.equal(autoSensitive.hybrid_enabled, true);
		assert.equal(autoSensitive.rerank_enabled, true);
	}
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
	assert.equal(
		resolveDocumentPolicy({ parsePreference: "local_only" })
			.enhanced_parser_allowed,
		false,
	);
});
