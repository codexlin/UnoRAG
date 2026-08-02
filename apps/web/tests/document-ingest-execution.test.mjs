import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
	dbosDocumentIngestEnabled,
	dbosDocumentIngestRouteEnabled,
	dbosTextIngestEnabled,
	dbosTextIngestRouteEnabled,
	documentIngestExecutionIdentity,
} from "../src/lib/server/document-lifecycle-flag.mjs";

const textPayload = {
	filename: "handbook.txt",
	content_type: "text/plain",
	queue_class: "local",
};
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

test("DBOS text ingest is opt-in and freezes identity at job creation", () => {
	assert.equal(dbosTextIngestEnabled({}), false);
	assert.equal(dbosTextIngestRouteEnabled({}), false);
	assert.equal(
		dbosTextIngestRouteEnabled({
			UNORAG_DBOS_TEXT_INGEST_ROUTE_ENABLED: "true",
			UNORAG_DBOS_TEXT_INGEST_ENABLED: "false",
		}),
		false,
	);
	assert.deepEqual(documentIngestExecutionIdentity("job-1", textPayload, {}), {
		executionEngine: "python",
		workflowId: null,
	});
	assert.deepEqual(
		documentIngestExecutionIdentity("job-1", textPayload, {
			UNORAG_DBOS_TEXT_INGEST_ENABLED: "true",
		}),
		{ executionEngine: "dbos", workflowId: "job-1" },
	);
	assert.deepEqual(
		documentIngestExecutionIdentity("job-1", textPayload, {
			UNORAG_DBOS_TEXT_INGEST_ENABLED: "true",
			UNORAG_DBOS_TEXT_INGEST_ROUTE_ENABLED: "false",
		}),
		{ executionEngine: "python", workflowId: null },
	);
});

test("DBOS document ingest primary flags route every supported format", () => {
	const enabled = {
		UNORAG_DBOS_DOCUMENT_INGEST_ENABLED: "true",
		UNORAG_DBOS_DOCUMENT_INGEST_ROUTE_ENABLED: "true",
	};
	assert.equal(dbosDocumentIngestEnabled(enabled), true);
	assert.equal(dbosDocumentIngestRouteEnabled(enabled), true);
	for (const payload of [
		textPayload,
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
			filename: "contract.pdf",
			content_type: "application/pdf",
			queue_class: "mineru",
		},
	]) {
		assert.deepEqual(
			documentIngestExecutionIdentity("job-document", payload, enabled),
			{ executionEngine: "dbos", workflowId: "job-document" },
		);
	}
});

test("legacy DBOS text cohort does not expand to binary formats during upgrade", () => {
	const enabled = { UNORAG_DBOS_TEXT_INGEST_ENABLED: "1" };
	for (const payload of [
		{
			filename: "contract.pdf",
			content_type: "application/pdf",
			queue_class: "auto",
		},
		{
			filename: "policy.docx",
			content_type:
				"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
			queue_class: "local",
		},
	]) {
		assert.deepEqual(
			documentIngestExecutionIdentity("job-2", payload, enabled),
			{ executionEngine: "python", workflowId: null },
		);
	}
	for (const payload of [
		{
			filename: "contract.pdf",
			content_type: "text/plain",
			queue_class: "local",
		},
		{
			filename: "notes.txt",
			content_type: "application/pdf",
			queue_class: "local",
		},
		{ filename: "notes.txt", content_type: "text/plain", queue_class: "auto" },
	]) {
		assert.deepEqual(
			documentIngestExecutionIdentity("job-2", payload, enabled),
			{ executionEngine: "python", workflowId: null },
		);
	}
});

test("DBOS text ingest deployment is opt-in and carries its runtime dependencies", () => {
	const compose = readFileSync(
		path.join(root, "../../deploy/compose/docker-compose.yml"),
		"utf8",
	);
	const dockerfile = readFileSync(
		path.join(root, "../../deploy/docker/web.Dockerfile"),
		"utf8",
	);
	const helm = readFileSync(
		path.join(root, "../../deploy/helm/unorag/templates/dbos-deployments.yaml"),
		"utf8",
	);
	const helmMigrations = readFileSync(
		path.join(root, "../../deploy/helm/unorag/templates/migrate-jobs.yaml"),
		"utf8",
	);
	const helmOutbox = readFileSync(
		path.join(
			root,
			"../../deploy/helm/unorag/templates/outbox-worker-deployment.yaml",
		),
		"utf8",
	);
	const values = readFileSync(
		path.join(root, "../../deploy/helm/unorag/values.yaml"),
		"utf8",
	);
	const runtime = readFileSync(
		path.join(root, "../../deploy/config/runtime.env.example"),
		"utf8",
	);
	const retryRoute = readFileSync(
		path.join(root, "src/app/api/jobs/[jobId]/retry/route.ts"),
		"utf8",
	);

	assert.match(
		compose,
		/UNORAG_DBOS_TEXT_INGEST_ENABLED: \$\{UNORAG_DBOS_TEXT_INGEST_ENABLED:-false\}/,
	);
	assert.match(
		compose,
		/UNORAG_DBOS_LISTEN_QUEUES: \$\{UNORAG_DBOS_LISTEN_QUEUES:-lifecycle\}/,
	);
	assert.match(
		compose,
		/dbos-worker:[\s\S]*DOCUMENT_MAX_UPLOAD_BYTES:[\s\S]*EMBEDDING_MODEL:/,
	);
	assert.match(dockerfile, /COPY apps\/web\/src\/core\/ingest/);
	assert.match(dockerfile, /COPY apps\/web\/src\/core\/document-ir/);
	assert.match(helm, /dbosTextIngestEnabled=true requires dbos\.enabled=true/);
	assert.match(
		helm,
		/ternary "ingest-local,lifecycle" "lifecycle"[\s\S]*dbosTextIngestEnabled/,
	);
	assert.equal(helm.match(/name: UNORAG_DBOS_TEXT_INGEST_ENABLED/g)?.length, 2);
	assert.match(values, /dbosTextIngestEnabled: "false"/);
	assert.match(values, /dbosTextIngestRouteEnabled: "false"/);
	assert.match(values, /outbox:\s+repository: unorag-web-outbox/s);
	assert.match(values, /aclProjectionGate:[\s\S]*enabled: true/);
	assert.match(values, /runtimeRoles:[\s\S]*enabled: true/);
	assert.match(helmOutbox, /\.Values\.images\.outbox\.repository/);
	assert.match(helmOutbox, /key: OUTBOX_DATABASE_URL/);
	assert.doesNotMatch(helmOutbox, /\.Values\.migrate\.web\.image\.repository/);
	assert.match(helmMigrations, /\.Release\.IsInstall/);
	assert.match(helmMigrations, /helm\.sh\/hook: post-install/);
	assert.match(helmMigrations, /helm\.sh\/hook: pre-upgrade/);
	assert.match(helmMigrations, /helm\.sh\/hook: post-upgrade/);
	assert.match(
		helmMigrations,
		/backfill-acl-projections\.mjs --apply[\s\S]*inspect-lifecycle\.mjs --fail-on-acl-projection/,
	);
	assert.match(helmMigrations, /\.Values\.images\.outbox\.repository/);
	assert.match(
		helmMigrations,
		/if \.Values\.migrate\.aclProjectionGate\.enabled/,
	);
	assert.match(
		helmMigrations,
		/dbosAclProjectionEnabled=true requires migrate\.aclProjectionGate\.enabled=true/,
	);
	assert.match(runtime, /UNORAG_DBOS_TEXT_INGEST_ENABLED=false/);
	assert.match(runtime, /UNORAG_DBOS_TEXT_INGEST_ROUTE_ENABLED=false/);
	assert.match(runtime, /UNORAG_DBOS_ACL_PROJECTION_ENABLED=false/);
	assert.match(
		helm,
		/dbosAclProjectionEnabled=true requires dbos\.enabled=true/,
	);
	assert.match(
		retryRoute,
		/documentIngestExecutionIdentity\(newJobId, retryPayload\)/,
	);
	assert.match(retryRoute, /current\.job\.type !== "document\.ingest"/);
	assert.match(retryRoute, /documentIngestPayloadSchema\.safeParse/);
});

test("Helm ACL hooks render for install, bootstrap, and externally migrated upgrades", (t) => {
	const probe = spawnSync("helm", ["version", "--short"], {
		encoding: "utf8",
	});
	if (probe.status !== 0) {
		t.skip("helm is not installed");
		return;
	}
	const chart = path.join(root, "../../deploy/helm/unorag");
	const render = (...args) =>
		spawnSync("helm", ["template", "unorag", chart, ...args], {
			encoding: "utf8",
		});

	const install = render("--set", "migrate.web.enabled=true");
	assert.equal(install.status, 0, install.stderr);
	assert.match(
		install.stdout,
		/name: unorag-acl-projection-gate[\s\S]*helm\.sh\/hook: post-install/,
	);

	const bootstrap = render(
		"--is-upgrade",
		"--set",
		"migrate.web.enabled=false",
		"--set",
		"dbos.enabled=true",
	);
	assert.equal(bootstrap.status, 0, bootstrap.stderr);
	assert.match(
		bootstrap.stdout,
		/name: unorag-acl-projection-gate[\s\S]*helm\.sh\/hook: post-upgrade/,
	);

	const gated = render(
		"--is-upgrade",
		"--set",
		"migrate.web.enabled=false",
		"--set",
		"dbos.enabled=true",
		"--set",
		"config.dbosAclProjectionEnabled=true",
	);
	assert.equal(gated.status, 0, gated.stderr);
	assert.match(
		gated.stdout,
		/name: unorag-acl-projection-gate[\s\S]*helm\.sh\/hook: pre-upgrade/,
	);
	assert.doesNotMatch(gated.stdout, /name: unorag-migrate-web/);

	const invalid = render(
		"--is-upgrade",
		"--set",
		"dbos.enabled=true",
		"--set",
		"config.dbosAclProjectionEnabled=true",
		"--set",
		"migrate.aclProjectionGate.enabled=false",
	);
	assert.notEqual(invalid.status, 0);
	assert.match(
		invalid.stderr,
		/requires migrate\.aclProjectionGate\.enabled=true/,
	);
});
