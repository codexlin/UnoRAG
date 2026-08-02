import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("only document ingest jobs can use the generic cancel path", () => {
	const route = readFileSync(
		path.join(root, "src/app/api/jobs/[jobId]/cancel/route.ts"),
		"utf8",
	);

	assert.match(route, /current\.job\.type !== "document\.ingest"/);
	assert.match(route, /only document ingest jobs can be cancelled/);
	assert.match(route, /\{ status: 409 \}/);
});

test("ingest cancellation uses the lifecycle lock order", () => {
	const route = readFileSync(
		path.join(root, "src/app/api/jobs/[jobId]/cancel/route.ts"),
		"utf8",
	);
	const libraryLock = route.indexOf(".from(libraries)");
	const documentLock = route.indexOf(".from(documents)");
	const versionLock = route.indexOf(".from(documentVersions)");
	const jobLock = route.indexOf(".from(jobs)");

	assert.ok(libraryLock > -1);
	assert.ok(documentLock > libraryLock);
	assert.ok(versionLock > documentLock);
	assert.ok(jobLock > versionLock);
	assert.match(route, /eq\(jobs\.type, "document\.ingest"\)/);
});

test("ingest retry cannot revive deleting documents and uses the lifecycle lock order", () => {
	const route = readFileSync(
		path.join(root, "src/app/api/jobs/[jobId]/retry/route.ts"),
		"utf8",
	);
	const libraryLock = route.indexOf(".from(libraries)");
	const documentLock = route.indexOf(".from(documents)");
	const versionLock = route.indexOf(".from(documentVersions)");
	const jobLock = route.indexOf(".from(jobs)");

	assert.ok(libraryLock > -1);
	assert.ok(documentLock > libraryLock);
	assert.ok(versionLock > documentLock);
	assert.ok(jobLock > versionLock);
	assert.match(route, /lockedLibrary\.status === "deleting"/);
	assert.match(route, /lockedLibrary\.status === "deleted"/);
	assert.match(route, /lockedDocument\.status === "deleting"/);
	assert.match(route, /lockedDocument\.status === "deleted"/);
	assert.match(
		route,
		/lockedDocument\.desiredVersionId !== current\.version\.id/,
	);
	assert.match(route, /lockedDocument\.latestJobId !== current\.job\.id/);
	assert.match(route, /eq\(jobs\.type, "document\.ingest"\)/);
});
