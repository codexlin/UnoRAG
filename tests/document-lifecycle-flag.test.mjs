import assert from "node:assert/strict";
import test from "node:test";

import { documentLifecycleV2Enabled } from "../src/lib/server/document-lifecycle-flag.mjs";

test("lifecycle v2 defaults on without env", () => {
	assert.equal(documentLifecycleV2Enabled({}), true);
	assert.equal(documentLifecycleV2Enabled({ NODE_ENV: "production" }), true);
});

test("legacy environment flags cannot disable the native lifecycle", () => {
	assert.equal(
		documentLifecycleV2Enabled({ DOCUMENT_LIFECYCLE_V2: "false" }),
		true,
	);
	assert.equal(
		documentLifecycleV2Enabled({ DOCUMENT_LIFECYCLE_V2: "0" }),
		true,
	);
});

test("lifecycle v2 accepts explicit enable", () => {
	assert.equal(
		documentLifecycleV2Enabled({ DOCUMENT_LIFECYCLE_V2: "true" }),
		true,
	);
});
