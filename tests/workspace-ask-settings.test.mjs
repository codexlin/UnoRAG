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
	resolvedAskAsOverrideKnobs,
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
	assert.equal(resolved.hybrid_enabled, true);
	assert.equal(resolved.rerank_enabled, false);
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

test("validateAskPatch accepts the 3 canonical business fields and rejects retired or internal keys", () => {
	const result = validateAskPatch({
		answer_profile: "precise",
		reranking: "on",
		session_memory_enabled: false,
	});
	assert.equal(result.ok, true);
	assert.deepEqual(result.patch, {
		answer_profile: "precise",
		reranking: "on",
		session_memory_enabled: false,
	});

	for (const invalid of [
		{ retrieve_top_k: 8 },
		{ hybrid_enabled: true },
		{ rerank_enabled: true },
		{ retrieval_enhancement: "auto" },
		{ hybrid_retrieval: "off" },
		{ evidence_requirement: "strict" },
		{ reranking: "inherit" },
		{ answer_profile: "turbo" },
		{ unknown_key: true },
		null,
	]) {
		assert.equal(
			validateAskPatch(invalid).ok,
			false,
			`expected rejection for ${JSON.stringify(invalid)}`,
		);
	}
});

test("historical migration 0026 remains immutable", () => {
	const migration = readFileSync(
		new URL("../drizzle/0026_migrate_ask_profiles.sql", import.meta.url),
		"utf8",
	);
	assert.match(migration, /WITH legacy_settings AS/);
	assert.match(migration, /jsonb_build_object\(/);
	assert.match(migration, /'answer_profile'/);
	assert.match(migration, /policy_version = settings\.policy_version \+ 1/);
});

test("answer_profile scales retrieval breadth and evidence floors cleanly", () => {
	const exploratory = resolveAskPolicy({
		answer_profile: "exploratory",
		reranking: "auto",
		session_memory_enabled: true,
	});
	const balanced = resolveAskPolicy({
		answer_profile: "balanced",
		reranking: "auto",
		session_memory_enabled: true,
	});
	const precise = resolveAskPolicy({
		answer_profile: "precise",
		reranking: "auto",
		session_memory_enabled: true,
	});
	assert.ok(precise.answer_min_score > balanced.answer_min_score);
	assert.ok(balanced.answer_min_score > exploratory.answer_min_score);
	assert.ok(precise.retrieve_top_k < exploratory.retrieve_top_k);
	assert.equal(precise.citation_adjudicate_enabled, true);
});

test("reranking auto/on/off resolve rerank while keeping hybrid retrieval enabled", () => {
	const off = resolveAskPolicy({
		...PUBLIC_ASK_DEFAULTS,
		reranking: "off",
	});
	assert.equal(off.hybrid_enabled, true);
	assert.equal(off.rerank_enabled, false);
	const offKnobs = resolvedAskAsOverrideKnobs(off);
	assert.equal(offKnobs.rerank_retry_enabled, false);

	const on = resolveAskPolicy({
		...PUBLIC_ASK_DEFAULTS,
		reranking: "on",
	});
	assert.equal(on.hybrid_enabled, true);
	assert.equal(on.rerank_enabled, true);
	assert.equal("rerank_retry_enabled" in resolvedAskAsOverrideKnobs(on), false);

	const auto = { ...PUBLIC_ASK_DEFAULTS, reranking: "auto" };
	const autoDefault = resolveAskPolicy(auto, { question: "请介绍休假政策。" });
	assert.equal(autoDefault.hybrid_enabled, true);
	assert.equal(autoDefault.rerank_enabled, false);
	assert.equal(
		"rerank_retry_enabled" in resolvedAskAsOverrideKnobs(autoDefault),
		false,
	);

	for (const question of [
		"对比方案A和方案B",
		"SKU-123",
		"合同编号 HT-2024-001 的金额是多少？",
		"项目组诊断出的第一个主要问题是什么？具体表现如何？",
		"发生概率最高的风险是哪一类？概率区间和影响程度如何？",
		"图4中总预算最高的部门是哪个？其基础设施投入占比多少？",
		"Compare Q1 vs Q2 gross margin across segments",
		"What does Clause 14.2 state about indemnity?",
		"Which region had the highest revenue ratio in Table 2?",
	]) {
		const autoSensitive = resolveAskPolicy(auto, { question });
		assert.equal(autoSensitive.hybrid_enabled, true);
		assert.equal(autoSensitive.rerank_enabled, true);
	}
});

test("pre-upgrade stored JSON projects cleanly onto the 3 canonical keys", () => {
	const legacyOnStrict = resolveAskPolicy({
		answer_profile: "balanced",
		retrieval_enhancement: "on",
		hybrid_retrieval: "inherit",
		reranking: "inherit",
		evidence_requirement: "strict",
		session_memory_enabled: false,
	});
	assert.deepEqual(legacyOnStrict.public, {
		answer_profile: "precise",
		reranking: "on",
		session_memory_enabled: false,
	});
	assert.equal(legacyOnStrict.rerank_enabled, true);

	const legacyOff = resolveAskPolicy({
		answer_profile: "balanced",
		retrieval_enhancement: "off",
		reranking: "inherit",
	});
	assert.deepEqual(legacyOff.public, {
		answer_profile: "balanced",
		reranking: "off",
		session_memory_enabled: true,
	});
	assert.equal(
		resolvedAskAsOverrideKnobs(legacyOff).rerank_retry_enabled,
		false,
	);
});

test("null patch key resets to public default", () => {
	const merged = mergeAskPatch(
		{ answer_profile: "precise", reranking: "on" },
		{ answer_profile: null, reranking: null },
	);
	assert.equal(merged.answer_profile, "balanced");
	assert.equal(merged.reranking, "auto");
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
