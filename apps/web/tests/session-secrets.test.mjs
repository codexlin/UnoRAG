import assert from "node:assert/strict";
import test from "node:test";

import {
	resolveInternalHeaderFamily,
	resolveInternalSecret,
	resolveSessionSecret,
} from "../src/lib/server/auth/secrets.mjs";

test("session secret is required and must be sufficiently long", () => {
	assert.throws(
		() => resolveSessionSecret({}),
		/UNORAG_SESSION_SECRET.*must contain at least 32 characters/,
	);
	assert.throws(
		() => resolveSessionSecret({ UNORAG_SESSION_SECRET: "too-short" }),
		/UNORAG_SESSION_SECRET.*must contain at least 32 characters/,
	);
});

test("session and internal signing secrets must be independent", () => {
	const sharedSecret = "a".repeat(32);
	assert.throws(
		() =>
			resolveSessionSecret({
				UNORAG_SESSION_SECRET: sharedSecret,
				UNORAG_INTERNAL_SECRET: sharedSecret,
			}),
		/session secret must differ from internal signing secret/,
	);
});

test("legacy MeriKnow secret names remain readable during rolling upgrades", () => {
	assert.equal(
		resolveSessionSecret({
			MERIKNOW_SESSION_SECRET: "s".repeat(32),
			MERIKNOW_INTERNAL_SECRET: "i".repeat(32),
		}),
		"s".repeat(32),
	);
	assert.equal(
		resolveInternalSecret({
			MERIKNOW_INTERNAL_SECRET: "i".repeat(32),
		}),
		"i".repeat(32),
	);
});

test("canonical UnoRAG secret names take precedence over legacy aliases", () => {
	assert.equal(
		resolveInternalSecret({
			UNORAG_INTERNAL_SECRET: "u".repeat(32),
			MERIKNOW_INTERNAL_SECRET: "m".repeat(32),
		}),
		"u".repeat(32),
	);
});

test("legacy header emission is explicit and invalid values fail closed", () => {
	assert.equal(resolveInternalHeaderFamily({}), "unorag");
	assert.equal(
		resolveInternalHeaderFamily({
			UNORAG_INTERNAL_AUTH_HEADER_FAMILY: "meriknow",
		}),
		"meriknow",
	);
	assert.throws(
		() =>
			resolveInternalHeaderFamily({
				UNORAG_INTERNAL_AUTH_HEADER_FAMILY: "automatic",
			}),
		/must be unorag or meriknow/,
	);
});

test("an independent session secret is accepted", () => {
	assert.equal(
		resolveSessionSecret({
			UNORAG_SESSION_SECRET: "s".repeat(32),
			UNORAG_INTERNAL_SECRET: "i".repeat(32),
		}),
		"s".repeat(32),
	);
});
