/**
 * Load deterministic fixtures against the TypeScript ask/document policy.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
	askPolicySnapshot,
	resolveAskPolicy,
} from "../src/lib/server/ask-policy.mjs";
import { resolveDocumentPolicy } from "../src/lib/server/document-policy.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, "contracts/policy-parity/fixtures.json");

function loadCases() {
	const payload = JSON.parse(readFileSync(FIXTURES, "utf8"));
	assert.ok(Array.isArray(payload.cases) && payload.cases.length > 0);
	return payload.cases;
}

test("policy-parity fixtures cover required kinds", () => {
	const kinds = new Set(loadCases().map((c) => c.kind));
	for (const required of ["ask_resolve", "document_resolve"]) {
		assert.ok(kinds.has(required), `missing kind ${required}`);
	}
});

test("TypeScript policy resolves all fixture cases", () => {
	for (const caseDef of loadCases()) {
		const inp = caseDef.input ?? {};
		if (caseDef.kind === "ask_resolve") {
			const snap = askPolicySnapshot(
				resolveAskPolicy(inp.raw, {
					question: inp.question ?? null,
					policyVersion:
						typeof inp.policy_version === "number" ? inp.policy_version : null,
				}),
			);
			assert.ok(snap.public && snap.resolved);
		} else if (caseDef.kind === "document_resolve") {
			const doc = resolveDocumentPolicy({
				documentProfile: inp.document_profile,
				scanHandling: inp.scan_handling,
				parsePreference: inp.parse_preference,
			});
			assert.ok(doc.chunk_profile);
		} else {
			assert.fail(`unknown kind ${caseDef.kind}`);
		}
	}
});
