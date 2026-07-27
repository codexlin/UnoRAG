import assert from "node:assert/strict";
import test from "node:test";

import { chooseAskLibraryId } from "../src/lib/ask-library-selection.mjs";

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

test("Ask restores the last valid library even when it is empty", () => {
	assert.equal(chooseAskLibraryId(libraries, "empty-new"), "empty-new");
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
