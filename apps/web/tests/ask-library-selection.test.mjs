import assert from "node:assert/strict";
import test from "node:test";

import {
	chooseAskLibraryId,
	isAskableLibrary,
} from "../src/lib/ask-library-selection.mjs";

const libraries = [
	{
		id: "empty-new",
		status: "empty",
		doc_count: 0,
		ready_count: 0,
	},
	{
		id: "ready-recent",
		status: "ready",
		doc_count: 1,
		ready_count: 1,
	},
	{
		id: "ready-older",
		status: "ready",
		doc_count: 2,
		ready_count: 2,
	},
];

test("Ask replaces a non-queryable stored library when usable content exists", () => {
	assert.equal(chooseAskLibraryId(libraries, "empty-new"), "ready-recent");
});

test("Ask defaults to the most recent ready library with content", () => {
	assert.equal(chooseAskLibraryId(libraries, null), "ready-recent");
	assert.equal(chooseAskLibraryId(libraries, "missing"), "ready-recent");
});

test("Ask places empty libraries after usable indexing libraries", () => {
	assert.equal(
		chooseAskLibraryId(
			[
				libraries[0],
				{
					id: "indexing",
					status: "indexing",
					doc_count: 1,
					ready_count: 0,
				},
			],
			null,
		),
		"indexing",
	);
});

test("Ask allows degraded or indexing libraries with active content", () => {
	const available = [
		{
			id: "degraded",
			status: "degraded",
			doc_count: 3,
			ready_count: 2,
		},
		{
			id: "indexing-with-active",
			status: "indexing",
			doc_count: 2,
			ready_count: 1,
		},
	];
	assert.equal(isAskableLibrary(available[0]), true);
	assert.equal(isAskableLibrary(available[1]), true);
	assert.equal(
		chooseAskLibraryId(available, "indexing-with-active"),
		"indexing-with-active",
	);
});

test("Ask preserves a non-queryable preference when no usable library exists", () => {
	const unavailable = [
		{ id: "failed", status: "failed", doc_count: 1, ready_count: 0 },
		{ id: "empty", status: "empty", doc_count: 0, ready_count: 0 },
	];
	assert.equal(chooseAskLibraryId(unavailable, "failed"), "failed");
	assert.equal(isAskableLibrary(unavailable[0]), false);
});

test("Ask ignores deleting libraries and handles an empty workspace", () => {
	assert.equal(
		chooseAskLibraryId(
			[
				{
					id: "deleting",
					status: "deleting",
					doc_count: 1,
					ready_count: 1,
				},
			],
			"deleting",
		),
		"",
	);
	assert.equal(chooseAskLibraryId([], null), "");
});
