#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const fixtureExtensions = /\.(csv|docx|html|jsonl|md|pdf|png|svg|txt)$/i;
const tracked = spawnSync(
	"git",
	["ls-files", "public", "testdata", "docs/brand"],
	{
		encoding: "utf8",
	},
);
if (tracked.status !== 0)
	throw new Error(tracked.stderr || "git ls-files failed");

const expected = tracked.stdout
	.split("\n")
	.filter(Boolean)
	.filter((path) => fixtureExtensions.test(path))
	.filter((path) => !path.endsWith("/README.md"))
	.filter((path) => path !== "docs/brand/uno-brand-system.md")
	.sort();

const manifest = JSON.parse(await readFile("assets/provenance.json", "utf8"));
if (!manifest.reviewed_at || !manifest.reviewed_by) {
	throw new Error("The provenance manifest requires reviewer and review date");
}
const entries = new Map();
for (const group of manifest.groups ?? []) {
	if (
		!group.id ||
		!group.origin ||
		!group.author ||
		!group.license ||
		!group.redistribution ||
		!group.evidence
	) {
		throw new Error(
			"Every provenance group requires id, origin, author, license, redistribution and evidence",
		);
	}
	for (const [path, sha256] of Object.entries(group.files ?? {})) {
		if (entries.has(path))
			throw new Error(`Duplicate provenance entry: ${path}`);
		entries.set(path, { sha256, group: group.id });
	}
}

const actual = [...entries.keys()].sort();
const missing = expected.filter((path) => !entries.has(path));
const stale = actual.filter((path) => !expected.includes(path));
if (missing.length || stale.length) {
	throw new Error(
		`Provenance coverage mismatch\nmissing: ${missing.join(", ")}\nstale: ${stale.join(", ")}`,
	);
}

for (const [path, entry] of entries) {
	const digest = createHash("sha256")
		.update(await readFile(path))
		.digest("hex");
	if (digest !== entry.sha256) {
		throw new Error(`Provenance hash mismatch for ${path} (${entry.group})`);
	}
}

console.log(
	`Verified provenance and SHA-256 for ${entries.size} redistributable assets and fixtures.`,
);
