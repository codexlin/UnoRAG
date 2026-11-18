import assert from "node:assert/strict";
import test from "node:test";

import { context, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
	BasicTracerProvider,
	InMemorySpanExporter,
	SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import type { LanguageModel } from "ai";
import {
	AnswerStreamAdapter,
	CHAT_SYSTEM_PROMPT,
	getPrompt,
	PROMPT_KEYS,
	PROMPT_REGISTRY,
	PROMPT_VERSION_HISTORY,
	promptSpanAttributes,
	StructuredOutputAdapter,
} from "../../src/core/ai";

const EXPECTED_DIGESTS = {
	chat: "a823611a82a1aca278decc13db5a104924a91f2d17db28b4c77508293c077d8a",
	router: "4f586e259c1fb7b4991d7014038887dd885168785edfd5fe0705cfb8a5862353",
	rewrite: "515f7cae7e09b2cdeb5dae09eafdebdb8bbdf9b8631d867f1ba1dd6bd604a7da",
	judge: "dcf69ce39ba3ae809ce1472a75193215065e1f7a2cb60e2155cb9b5d4b190abe",
	refusal_review:
		"7f35bbcecc1b3e7fd326e76c59213e791235432801c74254e3af87cdd0b7a675",
	conflict: "28aa307583ce89bbb7b0c84c091add0bb5506fff246a4b1dca5c388977dd1c7e",
	conflict_review:
		"27a3b3101b76d9ffc994c896d5e9b66b4d447691567cbeaf0ddbf431e17957d9",
	table_plan:
		"074c2f67f29bc44f7a72be0b1525490ef51719be3a9ba9ac4677b33198d5aab7",
} as const;

const EXPECTED_VERSIONS = {
	chat: "1.13.0",
	router: "1.0.0",
	rewrite: "2.1.0",
	judge: "1.12.0",
	refusal_review: "1.0.0",
	conflict: "2.3.0",
	conflict_review: "1.0.0",
	table_plan: "1.0.0",
} as const;

const EXPECTED_NAMES = {
	chat: "unorag.chat.answer",
	router: "unorag.query.router",
	rewrite: "unorag.query.rewrite",
	judge: "unorag.evidence.judge",
	refusal_review: "unorag.evidence.refusal_review",
	conflict: "unorag.evidence.conflict",
	conflict_review: "unorag.evidence.conflict_review",
	table_plan: "unorag.table.plan",
} as const;

const model = {} as LanguageModel;

async function collect(iterable: AsyncIterable<string>): Promise<string[]> {
	const values: string[] = [];
	for await (const value of iterable) values.push(value);
	return values;
}

test("prompt registry is complete and locks stable names, versions, and digests", () => {
	assert.equal(PROMPT_KEYS.length, 8);
	assert.deepEqual(Object.keys(PROMPT_REGISTRY), [...PROMPT_KEYS]);
	for (const key of PROMPT_KEYS) {
		const prompt = getPrompt(key);
		assert.equal(prompt.key, key);
		assert.equal(prompt.name, EXPECTED_NAMES[key]);
		assert.equal(prompt.version, EXPECTED_VERSIONS[key]);
		assert.equal(prompt.digest, EXPECTED_DIGESTS[key]);
		const history = PROMPT_VERSION_HISTORY[key] as Readonly<
			Record<string, string>
		>;
		assert.equal(history[prompt.version], prompt.digest);
		assert.match(prompt.digest, /^[a-f0-9]{64}$/);
		assert.ok(prompt.text.length > 20);
		assert.equal(Object.isFrozen(prompt), true);
	}
	assert.equal(Object.isFrozen(PROMPT_REGISTRY), true);
	assert.equal(CHAT_SYSTEM_PROMPT, getPrompt("chat").text);
});

test("prompt metadata contains identity only", () => {
	for (const key of PROMPT_KEYS) {
		const prompt = getPrompt(key);
		const attributes = promptSpanAttributes(prompt);
		assert.deepEqual(attributes, {
			"langfuse.observation.metadata.prompt_name": prompt.name,
			"langfuse.observation.metadata.prompt_version": prompt.version,
			"langfuse.observation.metadata.prompt_digest": prompt.digest,
		});
		assert.equal(JSON.stringify(attributes).includes(prompt.text), false);
	}
});

test("runtime adapters use registry instructions and export no prompt text", async () => {
	const exporter = new InMemorySpanExporter();
	const provider = new BasicTracerProvider({
		spanProcessors: [new SimpleSpanProcessor(exporter)],
	});
	const contextManager = new AsyncLocalStorageContextManager().enable();
	assert.equal(context.setGlobalContextManager(contextManager), true);
	assert.equal(trace.setGlobalTracerProvider(provider), true);

	const observed = new Map<string, string>();
	const structured = new StructuredOutputAdapter(
		model,
		async (request) => {
			observed.set(request.schemaName, request.instructions);
			switch (request.schemaName) {
				case "router":
					return { query_type: "fact", reason: "direct" };
				case "rewrite":
					return { resolution: "standalone", subjects: [] };
				case "judge":
					return {
						sufficient: true,
						action: "generate",
						reason: "covered",
						evidence_ids: ["chunk-1"],
					};
				case "refusal_review":
					return { missing_requirements: ["期限"], excerpts: [] };
				case "table_plan":
					return {
						mode: "single",
						operation: "count",
						tableId: "table-1",
						selectColumns: [],
						includeSummaryRows: false,
					};
				case "conflict":
					return {
						comparison: "same fact",
						resolution: "consistent",
						conflict_evidence: [],
					};
				case "conflict_review":
					return { incompatible: true };
			}
		},
		{ maxAttempts: 1 },
	);

	await structured.route({ question: "期限？" });
	await structured.rewrite({
		question: "期限？",
		history: [],
	});
	await structured.judge({ question: "期限？", citations: [], attempts: 1 });
	await structured.reviewRefusalWithMetadata({
		question: "期限？",
		requirements: { granularity: "unspecified", formal_name_required: false },
		citations: [],
	});
	await structured.checkConflictWithMetadata({
		question: "期限？",
		citations: [],
		evidence_ids: [],
	});
	await structured.reviewConflictWithMetadata({
		question: "期限？",
		citations: [],
	});
	await structured.planTable({ question: "多少行？", tables: [] });

	const answer = new AnswerStreamAdapter(model, (request) => {
		observed.set("chat", request.instructions);
		return (async function* () {
			yield "答案";
		})();
	});
	assert.deepEqual(
		await collect(answer.stream({ question: "期限？", context: "一年" })),
		["答案"],
	);

	for (const key of PROMPT_KEYS) {
		assert.equal(observed.get(key), getPrompt(key).text);
	}

	await provider.forceFlush();
	const spans = exporter
		.getFinishedSpans()
		.filter((span) =>
			["unorag.ai.structured", "unorag.ai.generate"].includes(span.name),
		);
	assert.equal(spans.length, 8);
	const reviewSpan = spans.find(
		(span) =>
			span.attributes["unorag.ai.structured_kind"] === "conflict_review",
	);
	assert.ok(reviewSpan);
	assert.equal(
		reviewSpan.attributes["langfuse.observation.metadata.prompt_name"],
		EXPECTED_NAMES.conflict_review,
	);
	assert.equal(
		reviewSpan.attributes["langfuse.observation.metadata.prompt_version"],
		EXPECTED_VERSIONS.conflict_review,
	);
	const exportedAttributes = JSON.stringify(
		spans.map((span) => span.attributes),
	);
	for (const key of PROMPT_KEYS) {
		const prompt = getPrompt(key);
		assert.equal(exportedAttributes.includes(prompt.name), true);
		assert.equal(exportedAttributes.includes(prompt.digest), true);
		assert.equal(exportedAttributes.includes(prompt.text), false);
	}

	await provider.shutdown();
	contextManager.disable();
});
