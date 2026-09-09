import assert from "node:assert/strict";
import test from "node:test";

import {
	errorGuidance,
	redactDiagnosticMessage,
} from "../../src/lib/error-diagnostics";

test("diagnostic messages redact credentials and remain bounded", () => {
	const redacted = redactDiagnosticMessage(
		"Authorization: Bearer-secret api_key=abc123 token=xyz789 https://provider.test/result?secret=hidden&ok=1 sk-live-example123456",
	);
	assert.equal(redacted?.includes("Bearer-secret"), false);
	assert.equal(redacted?.includes("abc123"), false);
	assert.equal(redacted?.includes("xyz789"), false);
	assert.equal(redacted?.includes("hidden"), false);
	assert.equal(redacted?.includes("sk-live-example123456"), false);
	assert.equal(redactDiagnosticMessage("x".repeat(3_000))?.length, 2_000);
});

test("error guidance groups parser, embedding, timeout, and unknown failures", () => {
	assert.equal(errorGuidance("mineru_unauthorized").title, "文档解析异常");
	assert.equal(errorGuidance("embedding_http_429").title, "Embedding 异常");
	assert.equal(errorGuidance("provider_timeout").title, "执行超时");
	assert.equal(errorGuidance("novel_failure").title, "未分类运行异常");
});
