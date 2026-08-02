import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

test("browser RAG boundary exposes only explicit TypeScript handlers", () => {
	const proxy = readFileSync(
		path.join(root, "src/lib/server/rag-proxy.ts"),
		"utf8",
	);
	for (const handler of [
		"handleNativeAskRequest",
		"handleNativeConversationRequest",
		"handleNativeDocumentDownloadRequest",
		"handleNativeHealthRequest",
		"handleNativeRetrievalRequest",
	]) {
		assert.match(proxy, new RegExp(handler));
	}
	assert.doesNotMatch(proxy, /RAG_API_URL/);
	assert.doesNotMatch(proxy, /createInternalRagHeaders/);
	assert.doesNotMatch(proxy, /fetch\s*\(/);
	assert.match(proxy, /RAG path not exposed/);
});
