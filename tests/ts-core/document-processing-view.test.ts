import assert from "node:assert/strict";
import test from "node:test";
import type { ApiDocument } from "../../src/lib/api";
import { documentProcessingView } from "../../src/lib/document-processing-view";

const document: ApiDocument = {
	id: "document",
	library_id: "library",
	name: "Example",
	filename: "example.md",
	content_type: "text/markdown",
	status: "ready",
	chunk_count: 3,
	created_at: "2026-11-13T00:00:00Z",
	updated_at: "2026-11-13T00:00:00Z",
};

test("task presentation never infers completion or active availability from document status", () => {
	assert.deepEqual(documentProcessingView(document), {
		label: "任务未记录",
		processing: false,
		failed: false,
		completed: false,
		cancelled: false,
		stage: null,
	});
	const replacement = documentProcessingView({
		...document,
		job_status: "failed",
		job_stage: "parsing",
	});
	assert.equal(replacement.label, "处理失败");
	assert.equal(replacement.failed, true);
	assert.equal(replacement.stage, null);
	assert.equal(replacement.completed, false);
});

test("known task states distinguish cancellation, processing, completion and unknown future states", () => {
	for (const status of ["queued", "retry", "running", "cancelling"]) {
		const view = documentProcessingView({
			...document,
			job_status: status,
			job_stage: "embedding",
		});
		assert.equal(view.processing, true);
		assert.equal(view.stage, "embedding");
		assert.equal(view.failed, false);
	}
	assert.equal(
		documentProcessingView({ ...document, job_status: "cancelled" }).cancelled,
		true,
	);
	assert.equal(
		documentProcessingView({ ...document, job_status: "completed" }).completed,
		true,
	);
	const exhausted = documentProcessingView({ ...document, job_status: "dead" });
	assert.equal(exhausted.label, "重试已耗尽");
	assert.equal(exhausted.failed, true);
	assert.equal(exhausted.processing, false);
	assert.equal(
		documentProcessingView({ ...document, job_status: "future-state" })
			.processing,
		false,
	);
});
