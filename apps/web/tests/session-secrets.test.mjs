import assert from "node:assert/strict";
import test from "node:test";

import { resolveSessionSecret } from "../src/lib/server/auth/secrets.mjs";

test("session secret is required and must be sufficiently long", () => {
	assert.throws(
		() => resolveSessionSecret({}),
		/MERIKNOW_SESSION_SECRET must contain at least 32 characters/,
	);
	assert.throws(
		() => resolveSessionSecret({ MERIKNOW_SESSION_SECRET: "too-short" }),
		/MERIKNOW_SESSION_SECRET must contain at least 32 characters/,
	);
});

test("session and internal signing secrets must be independent", () => {
	const sharedSecret = "a".repeat(32);
	assert.throws(
		() =>
			resolveSessionSecret({
				MERIKNOW_SESSION_SECRET: sharedSecret,
				MERIKNOW_INTERNAL_SECRET: sharedSecret,
			}),
		/MERIKNOW_SESSION_SECRET must differ from MERIKNOW_INTERNAL_SECRET/,
	);
});

test("an independent session secret is accepted", () => {
	assert.equal(
		resolveSessionSecret({
			MERIKNOW_SESSION_SECRET: "s".repeat(32),
			MERIKNOW_INTERNAL_SECRET: "i".repeat(32),
		}),
		"s".repeat(32),
	);
});
