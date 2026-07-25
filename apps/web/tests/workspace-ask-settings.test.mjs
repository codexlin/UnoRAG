import assert from "node:assert/strict";
import test from "node:test";

import { canManageMembers } from "../src/lib/server/workspace-permissions.mjs";
import {
	ASK_SETTING_DEFAULTS,
	mergeAskPatch,
	sanitizeStoredAsk,
	validateAskPatch,
} from "../src/lib/server/workspace-ask-settings.mjs";

test("defaults match API ASK_DEFAULTS ask knobs", () => {
	assert.equal(ASK_SETTING_DEFAULTS.retrieve_top_k, 6);
	assert.equal(ASK_SETTING_DEFAULTS.answer_min_score, 0.4);
	assert.equal(ASK_SETTING_DEFAULTS.hybrid_enabled, false);
	assert.equal(ASK_SETTING_DEFAULTS.rerank_enabled, false);
	assert.equal(ASK_SETTING_DEFAULTS.citation_adjudicate_enabled, true);
	assert.equal(ASK_SETTING_DEFAULTS.citation_adjudicate_absolute_floor, 0.35);
	assert.equal(ASK_SETTING_DEFAULTS.session_memory_enabled, true);
	assert.equal(ASK_SETTING_DEFAULTS.session_memory_max_turns, 10);
});

test("only owner and admin can manage workspace settings", () => {
	assert.equal(canManageMembers({ role: "viewer" }), false);
	assert.equal(canManageMembers({ role: "editor" }), false);
	assert.equal(canManageMembers({ role: "admin" }), true);
	assert.equal(canManageMembers({ role: "owner" }), true);
});

test("validateAskPatch accepts in-range values", () => {
	const result = validateAskPatch({
		retrieve_top_k: 8,
		answer_min_score: 0.55,
		hybrid_enabled: true,
		session_memory_max_turns: 0,
	});
	assert.equal(result.ok, true);
	assert.deepEqual(result.patch, {
		retrieve_top_k: 8,
		answer_min_score: 0.55,
		hybrid_enabled: true,
		session_memory_max_turns: 0,
	});
});

test("validateAskPatch rejects out-of-range and unknown keys", () => {
	assert.equal(validateAskPatch({ retrieve_top_k: 0 }).ok, false);
	assert.equal(validateAskPatch({ retrieve_top_k: 21 }).ok, false);
	assert.equal(validateAskPatch({ answer_min_score: 1.1 }).ok, false);
	assert.equal(
		validateAskPatch({ citation_adjudicate_absolute_floor: -0.1 }).ok,
		false,
	);
	assert.equal(validateAskPatch({ session_memory_max_turns: 21 }).ok, false);
	assert.equal(validateAskPatch({ unknown_key: true }).ok, false);
	assert.equal(validateAskPatch({ hybrid_enabled: "yes" }).ok, false);
	assert.equal(validateAskPatch(null).ok, false);
});

test("null clears a key; sanitize drops nulls", () => {
	const merged = mergeAskPatch(
		{ retrieve_top_k: 10, hybrid_enabled: true },
		{ retrieve_top_k: null, answer_min_score: 0.7 },
	);
	assert.deepEqual(merged, {
		hybrid_enabled: true,
		answer_min_score: 0.7,
	});
	assert.deepEqual(
		sanitizeStoredAsk({ retrieve_top_k: 3, hybrid_enabled: null, junk: 1 }),
		{ retrieve_top_k: 3 },
	);
});

test("false is a real override, not treated as unset", () => {
	const result = validateAskPatch({ hybrid_enabled: false });
	assert.equal(result.ok, true);
	assert.equal(result.patch.hybrid_enabled, false);
	const merged = mergeAskPatch({}, result.patch);
	assert.equal(merged.hybrid_enabled, false);
});
