import assert from "node:assert/strict";
import test from "node:test";

import {
	rejectDeployOnlyParseFields,
	resolveDocumentPolicy,
	resolveParsePlan,
	validateParsePreference,
} from "../src/lib/server/document-policy.mjs";
import {
	formatParseStatusView,
	redactProviderTaskId,
	resolveParserLabel,
} from "../src/lib/parse-status-view.mjs";

test("parse_preference maps to internal enhanced / prefer flags", () => {
	assert.equal(validateParsePreference("quality").ok, true);
	assert.equal(validateParsePreference("nope").ok, false);

	const quality = resolveDocumentPolicy({ parsePreference: "quality" });
	assert.equal(quality.prefer_enhanced, true);
	assert.equal(quality.enhanced_parser_allowed, true);

	const local = resolveDocumentPolicy({ parsePreference: "local_only" });
	assert.equal(local.enhanced_parser_allowed, false);
	assert.equal(local.prefer_enhanced, false);

	const disabledScan = resolveDocumentPolicy({
		parsePreference: "quality",
		scanHandling: "disabled",
	});
	assert.equal(disabledScan.enhanced_parser_allowed, false);
});

test("resolveParsePlan fail-closed when quality wants external but deploy forbids", () => {
	const blocked = resolveParsePlan({
		parsePreference: "quality",
		mineruEnabled: true,
		mineruProvider: "302ai",
		externalParserAllowed: false,
	});
	assert.equal(blocked.enhanced_parser_allowed, false);
	assert.equal(blocked.degrade_reason, "external_parser_forbidden");
	assert.equal(blocked.external_processing_allowed, false);

	const ok = resolveParsePlan({
		parsePreference: "quality",
		mineruEnabled: true,
		mineruProvider: "self_hosted",
		externalParserAllowed: false,
	});
	assert.equal(ok.enhanced_parser_allowed, true);
	assert.equal(ok.prefer_enhanced, true);
	assert.equal(ok.degrade_reason, null);
});

test("library API rejects deploy-only provider/key fields", () => {
	assert.equal(rejectDeployOnlyParseFields({ name: "ok" }).ok, true);
	const rejected = rejectDeployOnlyParseFields({
		name: "lib",
		MINERU_PROVIDER: "302ai",
		api_key: "secret",
	});
	assert.equal(rejected.ok, false);
	if (!rejected.ok) {
		assert.ok(rejected.fields.includes("MINERU_PROVIDER"));
		assert.ok(rejected.fields.includes("api_key"));
		assert.match(rejected.detail, /deploy-only/);
	}
});

test("parse status view exposes parser / external / degrade / redacted task id", () => {
	const view = formatParseStatusView({
		parserReport: {
			backend: "mineru",
			parser: "mineru",
			metrics: {
				mineru_provider: "302ai",
				mineru_external: true,
				mineru_task_id: "abcdefghijklmnop1234",
				route: "mineru",
				parse_quality_hint: "偏好：强制高质量解析",
			},
		},
		jobStatus: "running",
		jobStage: "parsing",
		parsePreference: "quality",
	});
	assert.equal(view.parser_label, "302 云解析");
	assert.equal(view.external_processing, true);
	assert.equal(view.task_status, "解析中");
	assert.equal(view.parse_quality_hint, "偏好：强制高质量解析");
	assert.equal(view.provider_task_id, "abcdefgh…1234");
	assert.equal(redactProviderTaskId("abcdefghijklmnop1234"), "abcdefgh…1234");
	assert.equal(resolveParserLabel({ backend: "pymupdf" }), "PyMuPDF");
	assert.equal(
		resolveParserLabel({
			backend: "mineru",
			metrics: { mineru_provider: "self_hosted" },
		}),
		"自建 MinerU",
	);
});

test("pending 302 job payload surfaces waiting status", () => {
	const view = formatParseStatusView({
		jobStatus: "queued",
		jobPayload: {
			mineru_provider_state: { status: "STARTED", task_id: "aabbccdd11223344" },
		},
	});
	assert.equal(view.task_status, "等待 302 云解析");
	assert.equal(view.provider_task_id, "aabbccdd…3344");
});
