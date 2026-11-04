import assert from "node:assert/strict";
import test from "node:test";
import yaml from "js-yaml";

import {
	dbosDocumentIngestEnabled,
	dbosDocumentIngestRouteEnabled,
	documentIngestExecutionIdentity,
} from "../src/lib/server/document-lifecycle-flag.mjs";
import {
	hasCommand,
	renderComposeConfig,
	renderHelm,
} from "./helpers/deployment-contracts.mjs";

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

test("Compose renders the complete TypeScript parser worker contract", () => {
	const compose = renderComposeConfig();
	const worker = compose.services["dbos-worker"];
	assert.ok(worker);
	assert.equal(
		worker.environment.UNORAG_DBOS_LISTEN_QUEUES,
		"ingest-local,ingest-auto,ingest-mineru,lifecycle",
	);
	assert.equal(worker.environment.MINERU_PROVIDER, "self_hosted");
	assert.equal(worker.environment.LITEPARSE_OCR_LANGUAGE, "ch");
	assert.equal("UNORAG_DBOS_TEXT_INGEST" in worker.environment, false);
	assert.deepEqual(worker.command, [
		"./node_modules/.bin/tsx",
		"src/worker/entry.ts",
	]);
});

test("Compose control-plane health observes the worker's selected MinerU provider", () => {
	for (const provider of ["self_hosted", "302ai"]) {
		const compose = renderComposeConfig({
			MINERU_PROVIDER: provider,
			MINERU_API_KEY: "contract-mineru-key",
			EXTERNAL_PARSER_ALLOWED: "true",
		});
		const worker = compose.services["dbos-worker"].environment;
		const control = compose.services["dbos-control"].environment;
		assert.equal(control.MINERU_PROVIDER, provider);
		for (const key of [
			"MINERU_PROVIDER",
			"MINERU_API_KEY",
			"MINERU_SELF_HOSTED_URL",
			"EXTERNAL_PARSER_ALLOWED",
		]) {
			assert.equal(control[key], worker[key], key);
		}
	}
});

test("Helm renders the TypeScript-only runtime", (t) => {
	if (!hasCommand("helm", ["version", "--short"])) {
		t.skip("helm is not installed");
		return;
	}
	const render = renderHelm();
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

test("Helm control-plane health observes the worker's selected MinerU provider", (t) => {
	if (!hasCommand("helm", ["version", "--short"])) {
		t.skip("helm is not installed");
		return;
	}
	for (const provider of ["self_hosted", "302ai"]) {
		const render = renderHelm([
			"--set",
			`config.mineruProvider=${provider}`,
			"--set",
			"config.externalParserAllowed=true",
		]);
		assert.equal(render.status, 0, render.stderr);
		const deployments = yaml
			.loadAll(render.stdout)
			.filter((doc) => ["Deployment", "StatefulSet"].includes(doc?.kind));
		const environment = (name) => {
			const deployment = deployments.find((doc) => doc.metadata.name === name);
			assert.ok(deployment, name);
			return Object.fromEntries(
				deployment.spec.template.spec.containers[0].env.map((entry) => [
					entry.name,
					entry.value ?? entry.valueFrom,
				]),
			);
		};
		const worker = environment("unorag-dbos-worker");
		const control = environment("unorag-dbos-control");
		assert.equal(control.MINERU_PROVIDER, provider);
		for (const key of [
			"MINERU_PROVIDER",
			"MINERU_API_KEY",
			"MINERU_SELF_HOSTED_URL",
			"EXTERNAL_PARSER_ALLOWED",
		]) {
			assert.deepEqual(control[key], worker[key], key);
		}
	}
});
