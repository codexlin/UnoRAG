import assert from "node:assert/strict";
import test from "node:test";

import { resolveSessionSecret } from "../src/lib/server/auth/secrets.mjs";

test("session secret is required and must be sufficiently long", () => {
	assert.throws(
		() => resolveSessionSecret({}),
		/UNORAG_SESSION_SECRET must contain at least 32 characters/,
	);
	assert.throws(
		() => resolveSessionSecret({ UNORAG_SESSION_SECRET: "too-short" }),
		/UNORAG_SESSION_SECRET must contain at least 32 characters/,
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
		/UNORAG_SESSION_SECRET must differ from UNORAG_INTERNAL_SECRET/,
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
