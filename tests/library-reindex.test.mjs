import assert from "node:assert/strict";
import test from "node:test";

import {
	libraryRequiresReindex,
	toApiLibrary,
} from "../src/lib/server/library-api.mjs";

test("library API preserves the authoritative stale-active-version count", () => {
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
	assert.equal(libraryRequiresReindex({ staleActiveVersions: 0 }), false);
	assert.equal(
		libraryRequiresReindex({
			appliedDocumentProfile: "table_heavy",
			documentProfile: "table_heavy",
			docCount: 2,
		}),
		false,
	);
});
