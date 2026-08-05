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
	chat: "0b9386aad530cc800bd97fd1cce4ca79eaeb1a4eb603fd3a8fbcd38ae4c46690",
	router: "4f586e259c1fb7b4991d7014038887dd885168785edfd5fe0705cfb8a5862353",
	rewrite: "81002875e2bfbf97afaee365f896b5a7a7c6528cea3c2242c4e26a40ab7d4104",
	judge: "f8671487f0b6fbe394a45718989ba81a7837370466468138ecb7feb21931e1bb",
	table_plan:
		"074c2f67f29bc44f7a72be0b1525490ef51719be3a9ba9ac4677b33198d5aab7",
} as const;

const EXPECTED_VERSIONS = {
	chat: "1.2.0",
	router: "1.0.0",
	rewrite: "1.0.0",
	judge: "1.1.0",
	table_plan: "1.0.0",
} as const;

const EXPECTED_NAMES = {
	chat: "unorag.chat.answer",
	router: "unorag.query.router",
	rewrite: "unorag.query.rewrite",
	judge: "unorag.evidence.judge",
	table_plan: "unorag.table.plan",
} as const;

const model = {} as LanguageModel;

async function collect(iterable: AsyncIterable<string>): Promise<string[]> {
	const values: string[] = [];
	for await (const value of iterable) values.push(value);
	return values;
}

test("prompt registry is complete and locks stable names, versions, and digests", () => {
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
					return { semantic_query: "合同期限", filters: {} };
				case "judge":
					return {
						sufficient: true,
						action: "generate",
						reason: "covered",
						evidence_ids: ["chunk-1"],
					};
				case "table_plan":
					return {
						mode: "single",
						operation: "count",
						tableId: "table-1",
						selectColumns: [],
						includeSummaryRows: false,
					};
			}
		},
		{ maxAttempts: 1 },
	);

	await structured.route({ question: "期限？" });
	await structured.rewrite({
		question: "期限？",
		fallbackSemanticQuery: "期限",
	});
	await structured.judge({ question: "期限？", citations: [], attempts: 1 });
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
	assert.equal(spans.length, 5);
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
