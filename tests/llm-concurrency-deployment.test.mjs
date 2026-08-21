import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFileSync(path.join(root, file), "utf8");

test("Compose and Helm deliver the shared LLM concurrency limit to Web", () => {
	const compose = read("deploy/compose/docker-compose.yml");
	const webBlock =
		compose.match(/^ {2}web:[\s\S]*?(?=^ {2}\S|(?![\s\S]))/m)?.[0] ?? "";
	assert.match(webBlock, /LLM_MAX_INFLIGHT: \$\{LLM_MAX_INFLIGHT:-4\}/);
	assert.match(webBlock, /LLM_MAX_QUEUE: \$\{LLM_MAX_QUEUE:-32\}/);
	assert.match(
		webBlock,
		/LLM_QUEUE_TIMEOUT_MS: \$\{LLM_QUEUE_TIMEOUT_MS:-30000\}/,
	);

	const values = read("deploy/helm/unorag/values.yaml");
	const configMap = read("deploy/helm/unorag/templates/configmap.yaml");
	assert.match(values, /llmMaxInflight: "4"/);
	assert.match(values, /llmMaxQueue: "32"/);
	assert.match(values, /llmQueueTimeoutMs: "30000"/);
	assert.match(
		configMap,
		/LLM_MAX_INFLIGHT: \{\{ \.Values\.config\.llmMaxInflight \| quote \}\}/,
	);
	assert.match(
		configMap,
		/LLM_MAX_QUEUE: \{\{ \.Values\.config\.llmMaxQueue \| quote \}\}/,
	);
	assert.match(
		configMap,
		/LLM_QUEUE_TIMEOUT_MS: \{\{ \.Values\.config\.llmQueueTimeoutMs \| quote \}\}/,
	);
});
