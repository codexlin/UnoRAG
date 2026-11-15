import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";

import {
	type DocumentIR,
	DocumentIRSchema,
	type ParserReport,
} from "../../src/core/document-ir";
import { buildIndexPayloads, chunkDocument } from "../../src/core/ingest";
import {
	type ContextualRetrievalOptions,
	contextualRetrievalFromEnvironment,
} from "../../src/core/ingest/contextual-retrieval";
import { mapQdrantHitToInternalCitation } from "../../src/core/retrieval/citation-mapper";
import { parseStoredQdrantPayload } from "../../src/core/retrieval/qdrant/payload";

const body = "The payment deadline is thirty days after acceptance. ".repeat(4);
const recordOptions = {
	documentId: "document-1",
	documentVersionId: "version-1",
	generationId: "11111111-1111-4111-8111-111111111111",
	libraryId: "library-1",
	organizationId: "organization-1",
	workspaceId: "workspace-1",
};

function document(
	nodes: unknown[] = [{ id: "p", type: "paragraph", text: body }],
	report: Partial<ParserReport> = {},
): DocumentIR {
	return DocumentIRSchema.parse({
		id: "document-1",
		library_id: "library-1",
		title: "Payment policy",
		filename: "policy.pdf",
		source_format: "pdf",
		nodes,
		parser_report: report,
	});
}

function pages(count: number): DocumentIR {
	return document(
		Array.from({ length: count }, (_, index) => ({
			id: `page-${index}`,
			type: "page",
			page_start: index + 1,
			text: body,
		})),
	);
}

function enhanced(input: DocumentIR, options: ContextualRetrievalOptions = {}) {
	return chunkDocument(input, {
		chunkSize: 500,
		chunkOverlap: 0,
		contextualRetrieval: { enabled: true, ...options },
	});
}

test("contextual retrieval is off by default even with an injected contextualizer", async () => {
	const input = document();
	let calls = 0;
	const baseline = await chunkDocument(input);
	const disabled = await chunkDocument(input, {
		contextualRetrieval: {
			contextualizer: {
				async contextualize() {
					calls += 1;
					return "must not run";
				},
			},
		},
	});
	assert.deepEqual(disabled, baseline);
	assert.equal(calls, 0);
	assert.ok(
		buildIndexPayloads(disabled, recordOptions).every(
			(record) => !("contextual_prefix" in record),
		),
	);
});

for (const condition of [
	{
		name: "no heading",
		heading: false,
		mode: "native",
		length: 160,
		expected: true,
	},
	{
		name: "short body",
		heading: false,
		mode: "ocr",
		length: 159,
		expected: false,
	},
	{
		name: "clear heading",
		heading: true,
		mode: "structured",
		length: 200,
		expected: false,
	},
	{
		name: "OCR mode with a heading",
		heading: true,
		mode: "ocr",
		length: 200,
		expected: true,
	},
	{
		name: "degraded mode with a heading",
		heading: true,
		mode: "degraded",
		length: 200,
		expected: true,
	},
	{
		name: "OCR page with a heading",
		heading: true,
		mode: "structured",
		length: 200,
		ocrPages: [3],
		expected: true,
	},
	{
		name: "another page is OCR",
		heading: true,
		mode: "structured",
		length: 200,
		ocrPages: [4],
		expected: false,
	},
]) {
	test(`contextual retrieval eligibility: ${condition.name}`, async () => {
		const input = document(
			[
				...(condition.heading
					? [
							{
								id: "h",
								type: "heading",
								level: 1,
								path: "Payment",
								text: "Payment",
							},
						]
					: []),
				{
					id: "p",
					type: "paragraph",
					text: "x".repeat(condition.length),
					page_start: 3,
					page_end: 3,
				},
			],
			{ mode: condition.mode, ocr_pages: condition.ocrPages ?? [] },
		);
		let calls = 0;
		const chunks = await enhanced(input, {
			contextualizer: {
				async contextualize() {
					calls += 1;
					return "Location context";
				},
			},
		});
		assert.equal(chunks.length, 1);
		assert.equal(calls, condition.expected ? 1 : 0);
		assert.equal(
			chunks[0].meta.contextual_prefix,
			condition.expected ? "Location context" : undefined,
		);
	});
}

for (const type of ["table", "figure", "code", "list"] as const) {
	test(`contextual retrieval excludes ${type} chunks even in OCR mode`, async () => {
		const input = document(
			[
				{
					id: "special",
					type,
					text: body,
					table_id: type === "table" ? "table-1" : null,
					figure_id: type === "figure" ? "figure-1" : null,
				},
			],
			{ mode: "ocr" },
		);
		let calls = 0;
		const chunks = await enhanced(input, {
			contextualizer: {
				async contextualize() {
					calls += 1;
					return "must not run";
				},
			},
		});
		assert.equal(calls, 0);
		assert.ok(
			chunks.every((chunk) => chunk.meta.contextual_prefix === undefined),
		);
	});
}

test("deterministic context uses same-document metadata and page without changing original text", async () => {
	const input = pages(1);
	const baseline = await chunkDocument(input, {
		chunkSize: 500,
		chunkOverlap: 0,
	});
	const chunks = await enhanced(input);
	const prefix = chunks[0].meta.contextual_prefix;
	assert.equal(prefix, "Payment policy / policy.pdf / p. 1");
	assert.deepEqual(chunks[0], {
		...baseline[0],
		meta: { ...baseline[0].meta, contextual_prefix: prefix },
	});
	assert.equal(chunks[0].body, body.trim());
});

test("contextual prefix truncation is bounded, single-line, and does not split surrogate pairs", async () => {
	const chunks = await enhanced(document(), {
		contextualizer: {
			async contextualize(input) {
				assert.equal(input.body, body.trim());
				assert.equal(input.documentTitle, "Payment policy");
				assert.equal(input.filename, "policy.pdf");
				assert.equal(input.signal.aborted, false);
				return `\n${"x".repeat(239)}😀 remainder\n`;
			},
		},
	});
	assert.equal(chunks[0].meta.contextual_prefix, "x".repeat(239));
	const [record] = buildIndexPayloads(chunks, recordOptions);
	assert.equal(record.contextual_prefix?.length, 239);
	assert.equal(record.body, body.trim());
});

test("contextual retrieval caps eligible attempts per document, including the hard limit", async () => {
	for (const [maxChunks, expected] of [
		[2, 2],
		[1000, 40],
		[0, 0],
	]) {
		let calls = 0;
		const chunks = await enhanced(pages(45), {
			maxChunks,
			contextualizer: {
				async contextualize() {
					calls += 1;
					return "Context";
				},
			},
		});
		assert.equal(calls, expected);
		assert.equal(
			chunks.filter((chunk) => chunk.meta.contextual_prefix).length,
			expected,
		);
		assert.equal(chunks.length, 45);
	}
});

test("contextualizer exceptions stop further attempts and fail soft to unchanged chunks", async () => {
	for (const synchronous of [true, false]) {
		const input = pages(2);
		const baseline = await chunkDocument(input, {
			chunkSize: 500,
			chunkOverlap: 0,
		});
		let calls = 0;
		const chunks = await enhanced(input, {
			contextualizer: {
				contextualize() {
					calls += 1;
					if (synchronous) throw new Error("provider failure");
					return Promise.reject(new Error("async provider failure"));
				},
			},
		});
		assert.equal(calls, 1);
		assert.deepEqual(chunks, baseline);
	}
});

test("contextualizer timeout aborts work and ignores late results", {
	timeout: 2000,
}, async () => {
	const input = pages(2);
	const baseline = await chunkDocument(input, {
		chunkSize: 500,
		chunkOverlap: 0,
	});
	let signal: AbortSignal | undefined;
	let resolveLate: ((value: string) => void) | undefined;
	let calls = 0;
	const chunks = await enhanced(input, {
		timeoutMs: 5,
		contextualizer: {
			contextualize(request) {
				calls += 1;
				signal = request.signal;
				return new Promise<string>((resolve) => {
					resolveLate = resolve;
				});
			},
		},
	});
	assert.equal(signal?.aborted, true);
	assert.equal(calls, 1);
	assert.deepEqual(chunks, baseline);
	assert.ok(resolveLate);
	resolveLate("late context must not appear");
	await setImmediate();
	assert.deepEqual(chunks, baseline);
});

test("empty contextualizer responses leave the original retrieval text unchanged", async () => {
	for (const value of [null, "", "  \n  "]) {
		const input = document();
		const baseline = buildIndexPayloads(
			await chunkDocument(input, { chunkSize: 500, chunkOverlap: 0 }),
			recordOptions,
		);
		const records = buildIndexPayloads(
			await enhanced(input, {
				contextualizer: {
					async contextualize() {
						return value;
					},
				},
			}),
			recordOptions,
		);
		assert.deepEqual(records, baseline);
	}
});

test("contextual retrieval environment settings are opt-in and numerically bounded", () => {
	assert.deepEqual(contextualRetrievalFromEnvironment({}), {
		enabled: false,
		maxChunks: 40,
		timeoutMs: 1000,
	});
	assert.deepEqual(
		contextualRetrievalFromEnvironment({
			CONTEXTUAL_RETRIEVAL_ENABLED: "true",
			CONTEXTUAL_RETRIEVAL_MAX_CHUNKS: "2",
			CONTEXTUAL_RETRIEVAL_TIMEOUT_MS: "15",
		}),
		{ enabled: true, maxChunks: 2, timeoutMs: 15 },
	);
	assert.deepEqual(
		contextualRetrievalFromEnvironment({
			CONTEXTUAL_RETRIEVAL_ENABLED: "1",
			CONTEXTUAL_RETRIEVAL_MAX_CHUNKS: "NaN",
			CONTEXTUAL_RETRIEVAL_TIMEOUT_MS: "invalid",
		}),
		{ enabled: false, maxChunks: 40, timeoutMs: 1000 },
	);
	assert.deepEqual(
		contextualRetrievalFromEnvironment({
			CONTEXTUAL_RETRIEVAL_MAX_CHUNKS: "500",
			CONTEXTUAL_RETRIEVAL_TIMEOUT_MS: "50000",
		}),
		{ enabled: false, maxChunks: 40, timeoutMs: 5000 },
	);
});

test("only narrative embedding and lexical context change; citations and other record grains stay original", async () => {
	const input = document([
		{ id: "p", type: "paragraph", text: body },
		{
			id: "t",
			type: "table",
			text: "Item | Count\nA | 12",
			table_id: "table-1",
			table_json: { headers: ["Item", "Count"], rows: [["A", "12"]] },
		},
		{ id: "f", type: "figure", text: body, figure_id: "figure-1" },
	]);
	const baseline = buildIndexPayloads(
		await chunkDocument(input, { chunkSize: 500, chunkOverlap: 0 }),
		{ ...recordOptions, document: input },
	);
	const chunks = await enhanced(input, {
		contextualizer: {
			async contextualize() {
				return "UNIQUE_SEARCH_CONTEXT";
			},
		},
	});
	const records = buildIndexPayloads(chunks, {
		...recordOptions,
		document: input,
	});
	assert.deepEqual(
		new Set(records.map((record) => record.record_type)),
		new Set([
			"chunk",
			"figure",
			"table",
			"table_summary",
			"section",
			"document",
		]),
	);
	let changed = 0;
	for (const record of records) {
		const original = baseline.find(
			(candidate) => candidate.record_id === record.record_id,
		);
		assert.ok(original);
		if (!record.contextual_prefix) {
			assert.deepEqual(record, original);
			continue;
		}
		changed += 1;
		assert.equal(record.record_type, "chunk");
		assert.equal(
			record.embed_text,
			`UNIQUE_SEARCH_CONTEXT\n\n${original.embed_text}`,
		);
		assert.equal(record.text, original.text);
		assert.equal(record.body, original.body);
		const stored = parseStoredQdrantPayload({
			...record,
			library_id: "library-1",
			doc_id: "document-1",
			title: "Payment policy",
		});
		assert.ok(stored);
		assert.equal(stored.contextual_prefix, "UNIQUE_SEARCH_CONTEXT");
		const citation = mapQdrantHitToInternalCitation(
			{ id: record._point_id, score: 0.9, payload: stored },
			1,
		);
		assert.equal(citation.body, original.body);
		assert.equal(citation.text, original.body);
		assert.equal(citation.snippet, original.body?.slice(0, 280));
		assert.equal(citation.tenant_id, "organization-1");
		assert.equal(citation.workspace_id, "workspace-1");
		assert.equal(citation.generation_id, recordOptions.generationId);
		assert.doesNotMatch(
			JSON.stringify(citation),
			/UNIQUE_SEARCH_CONTEXT|contextual_prefix/,
		);
	}
	assert.equal(changed, 1);
});
