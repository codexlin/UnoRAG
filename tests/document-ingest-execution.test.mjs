import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
	dbosDocumentIngestEnabled,
	dbosDocumentIngestRouteEnabled,
	documentIngestExecutionIdentity,
} from "../src/lib/server/document-lifecycle-flag.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const legacyDisabled = { UNORAG_DBOS_DOCUMENT_INGEST_ENABLED: "false" };

test("every supported format routes to DBOS without a feature flag", () => {
	assert.equal(dbosDocumentIngestEnabled(legacyDisabled), true);
	assert.equal(dbosDocumentIngestRouteEnabled(legacyDisabled), true);
	for (const payload of [
		{
			filename: "handbook.txt",
			content_type: "text/plain",
			queue_class: "local",
		},
		{
			filename: "policy.md",
			content_type: "text/markdown",
			queue_class: "local",
		},
		{
			filename: "policy.docx",
			content_type:
				"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
			queue_class: "local",
		},
		{
			filename: "contract.pdf",
			content_type: "application/pdf",
			queue_class: "auto",
		},
		{
			filename: "scan.pdf",
			content_type: "application/pdf",
			queue_class: "mineru",
		},
	]) {
		assert.deepEqual(
			documentIngestExecutionIdentity("job-document", payload, legacyDisabled),
			{ executionEngine: "dbos", workflowId: "job-document" },
		);
	}
});

test("deployment ships the complete TypeScript parser runtime", () => {
	const compose = readFileSync(
		path.join(root, "deploy/compose/docker-compose.yml"),
		"utf8",
	);
	const dockerfile = readFileSync(
		path.join(root, "deploy/docker/web.Dockerfile"),
		"utf8",
	);
	assert.match(compose, /^ {2}dbos-worker:/m);
	assert.match(
		compose,
		/UNORAG_DBOS_LISTEN_QUEUES:.*ingest-local,ingest-auto,ingest-mineru,lifecycle/,
	);
	assert.match(compose, /MINERU_PROVIDER/);
	assert.match(compose, /LITEPARSE_OCR_LANGUAGE/);
	assert.match(dockerfile, /COPY src \.\/src/);
	assert.doesNotMatch(compose, /UNORAG_DBOS_TEXT_INGEST/);
});

test("Helm renders the TypeScript-only runtime", (t) => {
	const probe = spawnSync("helm", ["version", "--short"], { encoding: "utf8" });
	if (probe.status !== 0) {
		t.skip("helm is not installed");
		return;
	}
	const chart = path.join(root, "deploy/helm/unorag");
	const render = spawnSync(
		"helm",
		["template", "unorag", chart, "--set", "config.openaiBaseUrl=http://llm"],
		{ encoding: "utf8" },
	);
	assert.equal(render.status, 0, render.stderr);
	assert.match(render.stdout, /name: unorag-dbos-worker/);
	assert.match(render.stdout, /name: UNORAG_DBOS_LISTEN_QUEUES/);
	assert.match(
		render.stdout,
		/value: "ingest-local,ingest-auto,ingest-mineru,lifecycle"/,
	);
	assert.doesNotMatch(
		render.stdout,
		/name: unorag-(api|outbox-worker|lifecycle-worker)/,
	);
});
