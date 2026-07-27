#!/usr/bin/env node
/**
 * Emit standardized policy-parity JSON from JS ask-policy / document-policy.
 *
 * Usage (from MeriKnow repo root):
 *   node scripts/policy_parity_js.mjs
 *   node scripts/policy_parity_js.mjs --out /tmp/js.json
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
	ASK_LEGACY_KEYS,
	askPolicySnapshot,
	migrateLegacyAskToPublic,
	resolveAskPolicy,
} from "../apps/web/src/lib/server/ask-policy.mjs";
import { resolveDocumentPolicy } from "../apps/web/src/lib/server/document-policy.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const DEFAULT_FIXTURES = join(
	REPO_ROOT,
	"tests/contracts/policy-parity/fixtures.json",
);

function stable(obj) {
	if (obj === null || typeof obj !== "object") return obj;
	if (Array.isArray(obj)) return obj.map(stable);
	const out = {};
	for (const key of Object.keys(obj).sort()) {
		out[key] = stable(obj[key]);
	}
	return out;
}

function runCase(caseDef) {
	const kind = caseDef.kind;
	const inp = caseDef.input ?? {};
	let output;
	if (kind === "ask_resolve") {
		const resolved = resolveAskPolicy(inp.raw, {
			question: inp.question ?? null,
			policyVersion:
				typeof inp.policy_version === "number" ? inp.policy_version : null,
		});
		output = askPolicySnapshot(resolved);
	} else if (kind === "ask_migrate") {
		output = migrateLegacyAskToPublic(inp.raw);
	} else if (kind === "document_resolve") {
		output = resolveDocumentPolicy({
			documentProfile: inp.document_profile,
			scanHandling: inp.scan_handling,
			parsePreference: inp.parse_preference,
		});
	} else if (kind === "override_keys") {
		output = { override_keys: [...ASK_LEGACY_KEYS] };
	} else {
		throw new Error(`unknown kind: ${kind}`);
	}
	return { id: caseDef.id, kind, output: stable(output) };
}

function buildReport(fixturesPath = DEFAULT_FIXTURES) {
	const payload = JSON.parse(readFileSync(fixturesPath, "utf8"));
	const results = payload.cases.map(runCase);
	return stable({
		version: payload.version ?? 1,
		runtime: "javascript",
		results,
	});
}

function parseArgs(argv) {
	let fixtures = DEFAULT_FIXTURES;
	let out = null;
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === "--fixtures") {
			fixtures = argv[++i];
		} else if (arg === "--out") {
			out = argv[++i];
		} else if (arg === "--help" || arg === "-h") {
			process.stdout.write(
				"Usage: node scripts/policy_parity_js.mjs [--fixtures path] [--out path]\n",
			);
			process.exit(0);
		}
	}
	return { fixtures, out };
}

const { fixtures, out } = parseArgs(process.argv.slice(2));
const report = buildReport(fixtures);
// Drop runtime before compare? Keep for human inspection; compare script strips it.
const text = `${JSON.stringify(report, null, 2)}\n`;
if (out) {
	writeFileSync(out, text, "utf8");
} else {
	process.stdout.write(text);
}
