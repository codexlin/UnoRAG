import assert from "node:assert/strict";
import test from "node:test";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { APICallError, type LanguageModel, RetryError } from "ai";
import { runEvidenceConflictChecks } from "../../scripts/acceptance/evidence-conflicts";
import {
	AiConcurrencyGate,
	AiConcurrencyOverloadedError,
	AiConcurrencyWaitTimeoutError,
	AiProviderConfigurationError,
	ANSWER_TEMPERATURE,
	AnswerStreamAdapter,
	aiConfigFromEnv,
	getStructuredFailureMetadata,
	judgeAiConfigFromEnv,
	StructuredOutputAdapter,
	StructuredOutputTimeoutError,
	StructuredOutputValidationError,
} from "../../src/core/ai";
import { assessEvidenceWithMetadata } from "../../src/core/ai/evidence-assessment";
import { ConflictOutputSchema } from "../../src/core/ai/structured-output";
import { deriveAnswerRequirements } from "../../src/core/ask-graph/answer-requirements";
import {
	type LegacySseEventName,
	projectPublicCitations,
	projectPublicRetrievalDebug,
	streamLegacyAskSse,
} from "../../src/server/http/ask/legacy-sse";

const injectedModel = {} as LanguageModel;

test("comparison and summary paths retain ordinary judgement without a same-fact conflict pass", async () => {
	for (const query_type of ["compare", "summary", "table", "section_lookup"]) {
		const calls: string[] = [];
		const adapter = new StructuredOutputAdapter(
			injectedModel,
			async (request) => {
				calls.push(request.schemaName);
				assert.equal(request.schemaName, "judge");
				return {
					sufficient: true,
					action: "generate",
					reason: "covered",
					evidence_ids: ["a", "b"],
				};
			},
		);
		const result = await assessEvidenceWithMetadata(adapter, {
			query_type,
			question: "哪个部门预算更高？",
			attempts: 1,
			citations: [
				{ id: "a", text: "销售部120万元" },
				{ id: "b", text: "研发部240万元" },
			],
		});
		assert.deepEqual(calls, ["judge"]);
		assert.deepEqual(result.output.evidence_ids, ["a", "b"]);
		assert.equal(result.output.evidence_resolution, "not_checked");
		assert.equal(result.output.judge_conflict_attempts, 0);
	}
});

test("conflict schema has an object root for structured-output provider compatibility", () => {
	const schema = ConflictOutputSchema.toJSONSchema();
	assert.equal(schema.type, "object");
	assert.equal(schema.anyOf, undefined);
	assert.deepEqual(schema.required, [
		"comparison",
		"resolution",
		"conflict_evidence",
	]);
});

test("conflict scope includes all selected-document candidates, explicit multi-document selections and shared identities only", async () => {
	for (const selected of [["a"], ["a", "c"]]) {
		let checked: string[] = [];
		const adapter = new StructuredOutputAdapter(
			injectedModel,
			async (request) => {
				if (request.schemaName === "judge")
					return {
						sufficient: true,
						action: "generate",
						reason: "covered",
						evidence_ids: selected,
					};
				checked = JSON.parse(String(request.messages[0].content)).citations.map(
					(item: { id: string }) => item.id,
				);
				return {
					comparison: "same",
					resolution: "consistent",
					conflict_evidence: [],
				};
			},
		);
		await assessEvidenceWithMetadata(adapter, {
			question: "期限？",
			attempts: 1,
			citations: [
				{ id: "a", doc_id: "d1", document_identity: ["POL-1"], text: "12日" },
				{ id: "b", doc_id: "d1", text: "24日" },
				{ id: "c", doc_id: "d2", text: "其他项目48日" },
				{ id: "d", doc_id: "d3", document_identity: ["POL-1"], text: "36日" },
			],
		});
		assert.deepEqual(
			checked,
			selected.length === 1 ? ["a", "b", "d"] : ["a", "b", "c", "d"],
		);
	}
});

test("separate conflict verification cannot widen ordinary evidence or turn a refusal into an answer", async () => {
	for (const action of ["generate", "retry", "refuse"] as const) {
		const calls: string[] = [];
		const adapter = new StructuredOutputAdapter(
			injectedModel,
			async (request) => {
				calls.push(request.schemaName);
				if (request.schemaName === "judge")
					return {
						sufficient: action === "generate",
						action,
						reason: "baseline",
						evidence_ids: action === "generate" ? ["a"] : [],
					};
				const sent = JSON.parse(String(request.messages[0].content));
				assert.equal(sent.citations.length, 2);
				assert.deepEqual(sent.evidence_ids, ["a"]);
				return {
					comparison: "private comparison",
					resolution: "consistent",
					conflict_evidence: [],
				};
			},
		);
		const result = await assessEvidenceWithMetadata(adapter, {
			question: "期限？",
			citations: [
				{ id: "a", text: "12日" },
				{ id: "b", text: "其他项目24日" },
			],
			attempts: 1,
		});
		assert.equal(result.output.action, action);
		assert.deepEqual(
			result.output.evidence_ids,
			action === "generate" ? ["a"] : [],
		);
		assert.deepEqual(
			calls,
			action === "generate" ? ["judge", "conflict"] : ["judge"],
		);
		assert.equal(JSON.stringify(result).includes("private comparison"), false);
		assert.equal(result.metadata.attempts, calls.length);
	}
});

test("conflict verification adds only exact authorized quotes and reauthorizes before the second call", async () => {
	for (const invalid of ["none", "foreign", "fabricated", "revoked"] as const) {
		let checkpoints = 0;
		const adapter = new StructuredOutputAdapter(
			injectedModel,
			async (request) => {
				if (request.schemaName === "judge")
					return {
						sufficient: true,
						action: "generate",
						reason: "covered",
						evidence_ids: ["a"],
					};
				return {
					comparison: "different",
					resolution: "conflict",
					conflict_evidence: [
						{ evidence_id: "a", quote: "12日" },
						{
							evidence_id: invalid === "foreign" ? "x" : "b",
							quote: invalid === "fabricated" ? "99日" : "24日",
						},
					],
				};
			},
			{ maxAttempts: 1 },
		);
		const run = () =>
			assessEvidenceWithMetadata(
				adapter,
				{
					question: "期限？",
					citations: [
						{ id: "a", text: "12日" },
						{ id: "b", text: "24日" },
					],
					attempts: 1,
				},
				{
					beforeRequest: async () => {
						if (++checkpoints === 2 && invalid === "revoked")
							throw new Error("revoked");
					},
				},
			);
		if (invalid !== "none") await assert.rejects(run);
		else {
			const result = await run();
			assert.deepEqual(result.output.evidence_ids, ["a", "b"]);
			assert.equal(result.output.reason, "evidence_conflict");
			assert.equal(result.output.judge_conflict_attempts, 1);
		}
		assert.equal(checkpoints, 2);
	}
});

test("scoped false refusals can recover only from exact original evidence, then check conflict", async () => {
	for (const [question, text] of [
		["发布前应做什么检查？", "发布前必须完成完整性校验。"],
		["补交材料期限和接收地点是什么？", "五日内将原件交至行政部前台。"],
	]) {
		const calls: string[] = [];
		let checkpoints = 0;
		const adapter = new StructuredOutputAdapter(
			injectedModel,
			async (request) => {
				calls.push(request.schemaName);
				if (request.schemaName === "judge")
					return {
						sufficient: false,
						action: "refuse",
						reason: "unrequested precision",
						evidence_ids: [],
					};
				const sent = JSON.parse(String(request.messages[0].content));
				assert.equal(sent.citations[0].text, text);
				assert.equal(sent.question, question);
				if (request.schemaName === "refusal_review") {
					assert.equal(
						JSON.stringify(sent).includes("unrequested precision"),
						false,
					);
					return {
						missing_requirements: [],
						excerpts: [{ evidence_id: "a", quote: text }],
					};
				}
				assert.deepEqual(sent.evidence_ids, ["a"]);
				return {
					comparison: "same",
					resolution: "consistent",
					conflict_evidence: [],
				};
			},
		);
		const result = await assessEvidenceWithMetadata(
			adapter,
			{
				question,
				query_type: "fact",
				resolvedDocumentId: "doc",
				citations: [{ id: "a", doc_id: "doc", text }],
				requirements: deriveAnswerRequirements(question),
				attempts: 1,
			},
			{
				beforeRequest: async () => {
					checkpoints++;
				},
			},
		);
		assert.deepEqual(calls, ["judge", "refusal_review", "conflict"]);
		assert.equal(checkpoints, 3);
		assert.equal(result.output.action, "generate");
		assert.deepEqual(result.output.evidence_ids, ["a"]);
		assert.equal(result.output.judge_refusal_review, "recovered");
		assert.equal(result.metadata.attempts, 3);
		assert.equal(JSON.stringify(result).includes(text), false);
	}
});

test("scoped refusal review keeps missing or fabricated evidence closed and does not review out of scope", async () => {
	for (const scenario of [
		"missing",
		"fabricated",
		"foreign_id",
		"other_doc",
		"unscoped",
		"comparison",
		"procedure",
		"address",
		"revoked",
	]) {
		const calls: string[] = [];
		let checkpoints = 0;
		const adapter = new StructuredOutputAdapter(
			injectedModel,
			async (request) => {
				calls.push(request.schemaName);
				if (request.schemaName === "judge")
					return {
						sufficient: false,
						action: "refuse",
						reason: "missing",
						evidence_ids: [],
					};
				assert.equal(request.schemaName, "refusal_review");
				return scenario === "missing"
					? { missing_requirements: ["具体检查项"], excerpts: [] }
					: {
							missing_requirements: [],
							excerpts: [
								{
									evidence_id: scenario === "foreign_id" ? "foreign" : "a",
									quote: scenario === "fabricated" ? "检查水压" : "备份校验",
								},
							],
						};
			},
		);
		const question =
			scenario === "procedure"
				? "检查名称及具体操作步骤是什么？"
				: scenario === "address"
					? "接收地点的街道和门牌号分别是什么？"
					: "发布前应做什么检查？";
		const run = () =>
			assessEvidenceWithMetadata(
				adapter,
				{
					question,
					query_type: scenario === "comparison" ? "compare" : "fact",
					resolvedDocumentId: scenario === "unscoped" ? undefined : "doc",
					requirements: deriveAnswerRequirements(question),
					citations: [
						{
							id: "a",
							doc_id: scenario === "other_doc" ? "other" : "doc",
							text: "发布前必须做备份校验。",
						},
					],
					attempts: 1,
				},
				{
					beforeRequest: async () => {
						if (++checkpoints === 2 && scenario === "revoked")
							throw new Error("revoked");
					},
				},
			);
		if (scenario === "revoked") {
			await assert.rejects(run, /revoked/u);
			assert.deepEqual(calls, ["judge"]);
			continue;
		}
		const { output } = await run();
		assert.equal(output.action, "refuse", scenario);
		assert.deepEqual(output.evidence_ids, []);
		if (["missing", "fabricated", "foreign_id"].includes(scenario)) {
			assert.deepEqual(calls, ["judge", "refusal_review"]);
			assert.equal(
				output.judge_refusal_review,
				scenario === "missing" ? "confirmed" : "invalid_evidence",
			);
		} else assert.deepEqual(calls, ["judge"], scenario);
	}
});

test("conflict provider failures remain technical errors with an identifiable stage", async () => {
	const adapter = new StructuredOutputAdapter(
		injectedModel,
		async (request) => {
			if (request.schemaName === "judge")
				return {
					sufficient: true,
					action: "generate",
					reason: "covered",
					evidence_ids: ["a"],
				};
			throw new Error("private provider body");
		},
		{ maxAttempts: 1 },
	);
	await assert.rejects(
		assessEvidenceWithMetadata(adapter, {
			question: "期限？",
			citations: [{ id: "a", text: "12日" }],
			attempts: 1,
		}),
		(error) => {
			assert.equal(getStructuredFailureMetadata(error)?.kind, "conflict");
			assert.doesNotMatch(
				JSON.stringify(getStructuredFailureMetadata(error)),
				/private/,
			);
			return true;
		},
	);
});

test("conflict checker controls keep mismatches and provider failures", async () => {
	const cases = [
		{
			id: "control",
			question: "期限？",
			expect_conflict: true,
			citations: [{ id: "a", text: "期限12日或24日" }],
		},
	];
	const adapter = {
		checkConflictWithMetadata: async () => ({
			output: {
				comparison: "different",
				resolution: "conflict" as const,
				conflict_evidence: [{ evidence_id: "a", quote: "期限12日或24日" }],
			},
			metadata: { attempts: 1, durationMs: 1 },
		}),
	};
	const rows = [];
	for await (const row of runEvidenceConflictChecks(adapter, cases, 2))
		rows.push(row);
	assert.equal(rows.length, 2);
	assert.ok(rows.every((row) => row.ok));
	for await (const row of runEvidenceConflictChecks(
		adapter,
		[{ ...cases[0], expect_conflict: false }],
		1,
	))
		assert.equal(row.ok, false);
	for await (const row of runEvidenceConflictChecks(
		{
			checkConflictWithMetadata: async () => {
				throw new Error("private body");
			},
		},
		cases,
		1,
	)) {
		assert.equal(row.ok, false);
		assert.doesNotMatch(JSON.stringify(row), /private body/);
	}
});

test("ordinary judge preserves its original contract without conflict fields", async () => {
	const output = {
		sufficient: true,
		action: "generate",
		reason: "covered",
		evidence_ids: ["a"],
	};
	const adapter = new StructuredOutputAdapter(
		injectedModel,
		async () => output,
	);
	assert.deepEqual(
		await adapter.judge({ question: "期限？", citations: [], attempts: 1 }),
		output,
	);
});

test("conflict checker rejects contradictory resolution and missing provenance", async () => {
	for (const output of [
		{ comparison: "different", resolution: "conflict", conflict_evidence: [] },
		{
			comparison: "scoped",
			resolution: "scoped",
			conflict_evidence: [{ evidence_id: "a", quote: "12日" }],
		},
		{
			comparison: "different",
			resolution: "conflict",
			conflict_evidence: [{ quote: "12日" }],
		},
	]) {
		const adapter = new StructuredOutputAdapter(
			injectedModel,
			async () => output,
			{ maxAttempts: 1 },
		);
		await assert.rejects(
			adapter.checkConflictWithMetadata({
				question: "期限？",
				citations: [],
				evidence_ids: [],
			}),
			StructuredOutputValidationError,
		);
	}
});

function judgeCompletion() {
	return Response.json({
		id: "judge-test",
		object: "chat.completion",
		created: 0,
		model: "judge",
		choices: [
			{
				index: 0,
				message: {
					role: "assistant",
					content: JSON.stringify({
						sufficient: true,
						action: "generate",
						reason: "supported",
						evidence_ids: ["source-1"],
					}),
				},
				finish_reason: "stop",
			},
		],
		usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
	});
}

test("SDK HTTP retries are owned by the adapter and reauthorize every attempt", async () => {
	let calls = 0;
	let checkpoints = 0;
	const provider = createOpenAICompatible({
		name: "test",
		apiKey: "test",
		baseURL: "https://provider.invalid/v1",
		fetch: async () =>
			++calls === 1
				? Response.json({ error: { message: "temporary" } }, { status: 503 })
				: judgeCompletion(),
	});
	const adapter = new StructuredOutputAdapter(
		provider.chatModel("judge"),
		undefined,
		{ maxAttempts: 2, timeoutMs: 1000 },
	);
	const result = await adapter.judgeWithMetadata(
		{ question: "question", citations: [], attempts: 1 },
		{
			beforeRequest: async () => {
				checkpoints += 1;
			},
		},
	);
	assert.equal(result.output.action, "generate");
	assert.equal(result.metadata.attempts, 2);
	assert.equal(calls, 2);
	assert.equal(checkpoints, 2);
});

test("a revoked authorization checkpoint prevents the SDK HTTP retry", async () => {
	let calls = 0;
	let checkpoints = 0;
	const denied = new Error("access revoked");
	const provider = createOpenAICompatible({
		name: "test",
		apiKey: "test",
		baseURL: "https://provider.invalid/v1",
		fetch: async () => {
			calls += 1;
			return Response.json(
				{ error: { message: "temporary" } },
				{ status: 503 },
			);
		},
	});
	const adapter = new StructuredOutputAdapter(
		provider.chatModel("judge"),
		undefined,
		{ maxAttempts: 2, timeoutMs: 1000 },
	);
	await assert.rejects(
		adapter.judge(
			{ question: "question", citations: [], attempts: 1 },
			{
				beforeRequest: async () => {
					if (++checkpoints === 2) throw denied;
				},
			},
		),
		(error) => error === denied,
	);
	assert.equal(calls, 1);
	assert.equal(checkpoints, 2);
});

test("Judge explicitly requests JSON in both native schema and JSON-object modes", async () => {
	for (const supportsStructuredOutputs of [true, false]) {
		const provider = createOpenAICompatible({
			name: "test",
			apiKey: "test",
			baseURL: "https://provider.invalid/v1",
			supportsStructuredOutputs,
			fetch: async (_url, init) => {
				const body = JSON.parse(String(init?.body));
				assert.equal(
					body.response_format.type,
					supportsStructuredOutputs ? "json_schema" : "json_object",
				);
				assert.match(body.messages[0].content, /JSON/u);
				assert.match(body.messages[0].content, /sufficient/u);
				assert.match(body.messages[0].content, /evidence_ids/u);
				return judgeCompletion();
			},
		});
		const adapter = new StructuredOutputAdapter(
			provider.chatModel("judge"),
			undefined,
			{ maxAttempts: 1, timeoutMs: 1000 },
		);
		const result = await adapter.judge({
			question: "question",
			citations: [],
			attempts: 1,
		});
		assert.equal(result.sufficient, true);
		assert.deepEqual(result.evidence_ids, ["source-1"]);
	}
});

test("default SDK executor classifies malformed JSON and schema failures as invalid output", async () => {
	for (const [content, finishReason, category] of [
		["private malformed text", "stop", "invalid_output"],
		['{"sufficient":true}', "stop", "invalid_output"],
		['{"sufficient":true,    ', "length", "output_truncated"],
	]) {
		const provider = createOpenAICompatible({
			name: "test",
			apiKey: "test",
			baseURL: "https://provider.invalid/v1",
			fetch: async () =>
				Response.json({
					id: "test",
					object: "chat.completion",
					created: 0,
					model: "judge",
					choices: [
						{
							index: 0,
							message: { role: "assistant", content },
							finish_reason: finishReason,
						},
					],
					usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
				}),
		});
		const adapter = new StructuredOutputAdapter(
			provider.chatModel("judge"),
			undefined,
			{ maxAttempts: 1, timeoutMs: 1000 },
		);
		await assert.rejects(
			adapter.judge({ question: "question", citations: [], attempts: 1 }),
			(error) => {
				const metadata = getStructuredFailureMetadata(error);
				assert.equal(metadata?.category, category);
				assert.equal(metadata?.attempts, 1);
				assert.doesNotMatch(JSON.stringify(metadata), /private|sufficient/);
				return true;
			},
		);
	}
});

test("structured failure diagnostics are bounded and do not leak provider data", async () => {
	const cause = new APICallError({
		message: "private provider body and sk-secret",
		url: "https://private.invalid",
		requestBodyValues: { secret: "sk-secret" },
		statusCode: 401,
		responseBody: "private document content",
		isRetryable: false,
	});
	const error = new RetryError({
		message: "private",
		reason: "errorNotRetryable",
		errors: [cause],
	});
	let calls = 0;
	const adapter = new StructuredOutputAdapter(
		injectedModel,
		async () => {
			calls += 1;
			throw error;
		},
		{ maxAttempts: 2, timeoutMs: 100 },
	);
	await assert.rejects(
		adapter.judge({ question: "private question", citations: [], attempts: 1 }),
		(caught) => caught === error,
	);
	assert.equal(calls, 1);
	const metadata = getStructuredFailureMetadata(error);
	assert.equal(metadata?.category, "authentication");
	assert.equal(metadata?.statusCode, 401);
	assert.equal(metadata?.retryable, false);
	assert.equal(metadata?.attempts, 1);
	assert.equal(metadata?.maxAttempts, 2);
	assert.equal(metadata?.budgetMs, 200);
	assert.doesNotMatch(JSON.stringify(metadata), /private|sk-secret/);
});

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
	const values: T[] = [];
	for await (const value of iterable) values.push(value);
	return values;
}

function parseFrame(frame: string): {
	event: LegacySseEventName;
	data: unknown;
} {
	const [eventLine, dataLine] = frame.trimEnd().split("\n");
	return {
		event: eventLine.replace("event: ", "") as LegacySseEventName,
		data: JSON.parse(dataLine.replace("data: ", "")),
	};
}

async function* tokens(...values: string[]): AsyncGenerator<string> {
	for (const value of values) yield value;
}

test("public citations are renumbered after evidence filtering", () => {
	assert.deepEqual(
		projectPublicCitations([
			{ id: "citation-a", index: 1 },
			{ id: "citation-c", index: 3 },
		]),
		[
			{ id: "citation-a", index: 1 },
			{ id: "citation-c", index: 2 },
		],
	);
});

test("provider configuration fails closed without an API key", () => {
	assert.throws(
		() => aiConfigFromEnv({} as NodeJS.ProcessEnv),
		(error) => error instanceof AiProviderConfigurationError,
	);
});

test("judge provider inherits the answer provider unless explicitly overridden", () => {
	const base = {
		OPENAI_API_KEY: "test-key",
		OPENAI_BASE_URL: "https://models.example/v1",
		CHAT_MODEL: "answer-model",
		AI_PROVIDER_NAME: "primary",
	} as unknown as NodeJS.ProcessEnv;
	assert.deepEqual(judgeAiConfigFromEnv(base), aiConfigFromEnv(base));
	assert.deepEqual(
		judgeAiConfigFromEnv({
			...base,
			JUDGE_BASE_URL: "https://judge.example/v1",
			JUDGE_MODEL: "judge-model",
			JUDGE_PROVIDER_NAME: "judge-provider",
			JUDGE_SUPPORTS_STRUCTURED_OUTPUTS: "false",
		} as NodeJS.ProcessEnv),
		{
			apiKey: "test-key",
			baseUrl: "https://judge.example/v1",
			chatModel: "judge-model",
			providerName: "judge-provider",
			supportsStructuredOutputs: false,
		},
	);
});

test("structured adapter rejects invalid model output and fixes temperature at zero", async () => {
	let temperature: number | undefined;
	const adapter = new StructuredOutputAdapter(
		injectedModel,
		async (request) => {
			temperature = request.temperature;
			return {
				query_type: "invented_type",
				reason: "bad",
				tenant_id: "must-not-pass",
			};
		},
	);

	await assert.rejects(
		adapter.route({ question: "合同期限是什么？" }),
		(error) =>
			error instanceof StructuredOutputValidationError &&
			error.kind === "router",
	);
	assert.equal(temperature, 0);
});

test("structured adapter retries a transient failure within the configured bound", async () => {
	let attempts = 0;
	const adapter = new StructuredOutputAdapter(
		injectedModel,
		async () => {
			attempts += 1;
			if (attempts === 1) throw new Error("temporary provider failure");
			return { query_type: "fact", reason: "direct question" };
		},
		{ maxAttempts: 2, timeoutMs: 1_000 },
	);

	assert.deepEqual(await adapter.route({ question: "合同期限是什么？" }), {
		query_type: "fact",
		reason: "direct question",
	});
	assert.equal(attempts, 2);
});

test("judge metadata is content-free and carries bounded execution details", async () => {
	let maxOutputTokens = 0;
	const adapter = new StructuredOutputAdapter(
		injectedModel,
		async (request) => {
			maxOutputTokens = request.maxOutputTokens ?? 0;
			return {
				sufficient: true,
				action: "generate",
				reason: "supported",
				evidence_ids: ["citation-1"],
			};
		},
		{ maxAttempts: 1, maxOutputTokens: 96 },
	);
	const judged = await adapter.judgeWithMetadata({
		question: "secret question",
		citations: [{ text: "secret evidence" }],
		attempts: 1,
	});

	assert.equal(judged.output.action, "generate");
	assert.equal(judged.metadata.attempts, 1);
	assert.equal(judged.metadata.durationMs >= 0, true);
	assert.equal(maxOutputTokens, 96);
	assert.equal(JSON.stringify(judged.metadata).includes("secret"), false);
});

test("public retrieval debug exposes only safe Judge diagnostics", () => {
	assert.deepEqual(
		projectPublicRetrievalDebug({
			judge_mode: "model",
			judge_model: "judge-model",
			judge_provider: "judge-provider",
			judge_attempts: 1,
			judge_duration_ms: 123.4,
			judge_sufficiency_duration_ms: 50,
			judge_conflict_duration_ms: 73.4,
			conflict_scope: "selected_documents",
			conflict_candidate_count: 4,
			judge_input_tokens: 800,
			judge_output_tokens: 20,
			judge_total_tokens: 820,
			retrieved_evidence_count: 6,
			selected_evidence_count: 2,
			evidence_selection_mode: "judge",
			evidence_selection_valid: true,
			question: "must not pass",
			evidence: "must not pass",
			comparison: "must not pass",
			conflict_evidence: [
				{ evidence_id: "private-id", quote: "must not pass" },
			],
		}),
		{
			judge_mode: "model",
			judge_model: "judge-model",
			judge_provider: "judge-provider",
			judge_attempts: 1,
			judge_duration_ms: 123.4,
			judge_sufficiency_duration_ms: 50,
			judge_conflict_duration_ms: 73.4,
			conflict_scope: "selected_documents",
			conflict_candidate_count: 4,
			judge_input_tokens: 800,
			judge_output_tokens: 20,
			judge_total_tokens: 820,
			retrieved_evidence_count: 6,
			selected_evidence_count: 2,
			evidence_selection_mode: "judge",
			evidence_selection_valid: true,
		},
	);
});

test("public rerank diagnostics strip content and reject unclassified strings", () => {
	const diagnostic = RerankDiagnosticSchema.parse({
		...Object.fromEntries(
			Object.keys(RerankDiagnosticSchema.shape).map((key) => [key, 0]),
		),
		category: "http",
		statusCode: 503,
		attempts: 2,
		durationMs: 400,
		timeoutMs: 1000,
		maxAttempts: 3,
		resultCount: null,
	});
	const projected = projectPublicRetrievalDebug({
		rerankDiagnostic: {
			...diagnostic,
			query: "private query",
			responseBody: "private response",
			headers: { authorization: "private auth" },
		},
	});
	assert.deepEqual(projected.rerank_diagnostic, diagnostic);
	assert.doesNotMatch(JSON.stringify(projected), /private/);
	assert.deepEqual(
		projectPublicRetrievalDebug({
			rerankDiagnostic: { ...diagnostic, category: "private exception" },
		}),
		{},
	);
});

test("structured adapter reports a bounded timeout and does not invent clarify judge actions", async () => {
	const concurrencyGate = new AiConcurrencyGate(1);
	const adapter = new StructuredOutputAdapter(
		injectedModel,
		(request) =>
			new Promise((_, reject) => {
				request.abortSignal?.addEventListener(
					"abort",
					() => reject(request.abortSignal?.reason),
					{ once: true },
				);
			}),
		{ maxAttempts: 1, timeoutMs: 5, concurrencyGate },
	);
	assert.deepEqual(concurrencyGate.snapshot(), {
		active: 0,
		queued: 0,
		limit: 1,
	});

	await assert.rejects(
		adapter.route({ question: "合同期限是什么？" }),
		(error) =>
			error instanceof StructuredOutputTimeoutError &&
			error.kind === "router" &&
			error.timeoutMs === 5,
	);
	assert.deepEqual(concurrencyGate.snapshot(), {
		active: 0,
		queued: 0,
		limit: 1,
	});

	const invalidJudge = new StructuredOutputAdapter(
		injectedModel,
		async () => ({
			sufficient: false,
			action: "clarify",
			reason: "ambiguous",
		}),
		{ maxAttempts: 1 },
	);
	await assert.rejects(
		invalidJudge.judge({
			question: "合同期限是什么？",
			citations: [],
			attempts: 1,
		}),
		(error) =>
			error instanceof StructuredOutputValidationError &&
			error.kind === "judge",
	);
});

test("answer adapter streams injected tokens with current prompt and temperature", async () => {
	let observedTemperature: number | undefined;
	let observedSystem = "";
	const adapter = new AnswerStreamAdapter(injectedModel, (request) => {
		observedTemperature = request.temperature;
		observedSystem = request.instructions;
		assert.notEqual(request.messages[0]?.role, "system");
		return tokens("违约金", "是 200 元");
	});

	assert.deepEqual(
		await collect(
			adapter.stream({
				question: "违约金是多少？",
				context: "[1] 违约金为 200 元。",
			}),
		),
		["违约金", "是 200 元"],
	);
	assert.equal(observedTemperature, ANSWER_TEMPERATURE);
	assert.match(observedSystem, /资料未覆盖/);
});

test("legacy SSE preserves order and removes internal scope and debug fields", async () => {
	const frames = await collect(
		streamLegacyAskSse({
			meta: {
				session_id: "session-1",
				trace_id: "trace-1",
				tenant_id: "tenant-secret",
				retrieval_debug: { filters: "secret" },
			},
			citations: [
				{
					id: "citation-1",
					index: 1,
					title: "合同",
					snippet: "违约金为 200 元",
					score: 0.9,
					doc_id: "doc-1",
					text: "private full body",
					tenant_id: "tenant-secret",
					generation_id: "generation-secret",
				},
			],
			tokens: tokens("违约金", "为 200 元"),
			done: {
				session_id: "session-1",
				trace_id: "trace-1",
				retrieval_debug: { score: 1 },
				workspace_id: "workspace-secret",
			},
		}),
	);
	const events = frames.map(parseFrame);

	assert.deepEqual(
		events.map((event) => event.event),
		["meta", "citations", "token", "token", "done"],
	);
	assert.equal(JSON.stringify(events).includes("tenant-secret"), false);
	assert.equal(JSON.stringify(events).includes("workspace-secret"), false);
	assert.equal(JSON.stringify(events).includes("generation-secret"), false);
	assert.deepEqual(events[2]?.data, "违约金");
	assert.deepEqual(events.at(-1)?.data, {
		session_id: "session-1",
		trace_id: "trace-1",
		answer: "违约金为 200 元",
		retrieval_debug: {},
		citations: [
			{
				id: "citation-1",
				index: 1,
				title: "合同",
				snippet: "违约金为 200 元",
				score: 0.9,
				document_id: "doc-1",
				doc_id: "doc-1",
				text: "private full body",
			},
		],
		truncated: false,
	});
});

test("legacy SSE emits a truncated error after a partial stream failure", async () => {
	async function* failingTokens(): AsyncGenerator<string> {
		yield "部分";
		throw new Error("provider secret must not leak");
	}
	const events = (
		await collect(
			streamLegacyAskSse({
				meta: { session_id: "session-1" },
				citations: [],
				tokens: failingTokens(),
				done: {},
			}),
		)
	).map(parseFrame);

	assert.deepEqual(
		events.map((event) => event.event),
		["meta", "citations", "token", "error"],
	);
	assert.deepEqual(events.at(-1)?.data, {
		message: "流式生成失败",
		code: "stream_failed",
		truncated: true,
	});
	assert.equal(JSON.stringify(events).includes("provider secret"), false);
});

test("legacy SSE exposes stable bounded LLM pressure outcomes", async () => {
	for (const [error, code] of [
		[new AiConcurrencyOverloadedError(), "llm_overloaded"],
		[new AiConcurrencyWaitTimeoutError(30_000), "llm_queue_timeout"],
	] as const) {
		async function* unavailable(): AsyncGenerator<string> {
			yield await Promise.reject(error);
		}
		const events = (
			await collect(
				streamLegacyAskSse({
					meta: {},
					citations: [],
					tokens: unavailable(),
					done: {},
				}),
			)
		).map(parseFrame);
		const terminal = events.at(-1);
		assert.equal(terminal?.event, "error");
		assert.equal((terminal?.data as { code?: string } | undefined)?.code, code);
		assert.equal(JSON.stringify(events).includes("30000"), false);
	}
});

test("legacy SSE terminates aborted streams without done", async () => {
	const controller = new AbortController();
	async function* abortingTokens(): AsyncGenerator<string> {
		yield "第一段";
		controller.abort();
		yield "不应发送";
	}
	const events = (
		await collect(
			streamLegacyAskSse({
				meta: { session_id: "session-1" },
				citations: [],
				tokens: abortingTokens(),
				done: {},
				abortSignal: controller.signal,
			}),
		)
	).map(parseFrame);

	assert.deepEqual(
		events.map((event) => event.event),
		["meta", "citations", "token", "error"],
	);
	assert.deepEqual(events.at(-1)?.data, {
		message: "流式生成已取消",
		code: "aborted",
		truncated: true,
	});
});

import { RerankDiagnosticSchema } from "../../src/core/retrieval/provider-request";
