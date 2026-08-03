import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
	libraryRequiresReindex,
	toApiLibrary,
} from "../src/lib/server/library-api.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function computeRequiresReindex({ library, activeVersions }) {
	const pendingProfile = String(library.documentProfile || "auto");
	const pendingScan = String(library.scanHandling || "auto");
	const pendingPreference = String(library.parsePreference || "auto");
	const pendingVersion = Number(library.ingestPolicyVersion) || 1;
	if (!activeVersions.length) return false;
	return activeVersions.some(
		(version) =>
			String(version.documentProfile ?? "auto") !== pendingProfile ||
			String(version.scanHandling ?? "auto") !== pendingScan ||
			String(version.parsePreference ?? "auto") !== pendingPreference ||
			(Number(version.ingestPolicyVersion ?? 0) || 0) !== pendingVersion,
	);
}

test("requires_reindex false when all active versions match library policy", () => {
	assert.equal(
		computeRequiresReindex({
			library: {
				documentProfile: "table_heavy",
				scanHandling: "auto",
				ingestPolicyVersion: 2,
			},
			activeVersions: [
				{
					documentProfile: "table_heavy",
					scanHandling: "auto",
					ingestPolicyVersion: 2,
				},
			],
		}),
		false,
	);
});

test("requires_reindex true when one active version is on older profile", () => {
	assert.equal(
		computeRequiresReindex({
			library: {
				documentProfile: "table_heavy",
				scanHandling: "auto",
				ingestPolicyVersion: 3,
			},
			activeVersions: [
				{
					documentProfile: "auto",
					scanHandling: "auto",
					ingestPolicyVersion: 1,
				},
				{
					documentProfile: "table_heavy",
					scanHandling: "auto",
					ingestPolicyVersion: 3,
				},
			],
		}),
		true,
	);
});

test("requires_reindex true when scan_handling diverges (OCR policy applied)", () => {
	assert.equal(
		computeRequiresReindex({
			library: {
				documentProfile: "auto",
				scanHandling: "force_ocr",
				ingestPolicyVersion: 1,
			},
			activeVersions: [
				{
					documentProfile: "auto",
					scanHandling: "auto",
					ingestPolicyVersion: 1,
				},
			],
		}),
		true,
	);
	assert.equal(
		computeRequiresReindex({
			library: {
				documentProfile: "auto",
				scanHandling: "force_ocr",
				ingestPolicyVersion: 1,
			},
			activeVersions: [
				{
					documentProfile: "auto",
					scanHandling: "force_ocr",
					ingestPolicyVersion: 1,
				},
			],
		}),
		false,
	);
});

test("one newly indexed doc must not clear whole-library reindex", () => {
	// Library-level applied_* alone must not drive requires_reindex.
	const api = toApiLibrary({
		ragLibraryId: "lib-1",
		name: "Lib",
		description: null,
		status: "ready",
		docCount: 2,
		readyCount: 2,
		documentProfile: "table_heavy",
		appliedDocumentProfile: "table_heavy",
		scanHandling: "auto",
		ingestPolicyVersion: 2,
		staleActiveVersions: 1,
		createdAt: new Date("2026-01-01T00:00:00.000Z"),
		updatedAt: new Date("2026-01-01T00:00:00.000Z"),
	});
	assert.equal(api.requires_reindex, true);
	assert.equal(libraryRequiresReindex({ staleActiveVersions: 1 }), true);
	assert.equal(
		libraryRequiresReindex({
			appliedDocumentProfile: "table_heavy",
			documentProfile: "table_heavy",
			docCount: 2,
		}),
		false,
	);
});

test("requires_reindex true when parse_preference diverges", () => {
	assert.equal(
		computeRequiresReindex({
			library: {
				documentProfile: "auto",
				scanHandling: "auto",
				parsePreference: "quality",
				ingestPolicyVersion: 1,
			},
			activeVersions: [
				{
					documentProfile: "auto",
					scanHandling: "auto",
					parsePreference: "auto",
					ingestPolicyVersion: 1,
				},
			],
		}),
		true,
	);
});

test("stale-version correlated SQL qualifies outer library columns", () => {
	const source = readFileSync(
		path.join(root, "src/lib/server/library-reindex-sql.ts"),
		"utf8",
	);
	for (const column of [
		"id",
		"document_profile",
		"scan_handling",
		"parse_preference",
		"ingest_policy_version",
	]) {
		assert.match(source, new RegExp(`"app"\\."libraries"\\."${column}"`));
	}
});
