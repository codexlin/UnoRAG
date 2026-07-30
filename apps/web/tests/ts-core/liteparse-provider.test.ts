import assert from "node:assert/strict";
import { test } from "node:test";

import type { ParseInput } from "../../src/core/contracts";
import {
	type DurableParseOptions,
	type LiteParseExecutor,
	type LiteParseOutput,
	LiteParseProvider,
	LiteParseProviderError,
} from "../../src/core/parsing";

const input: ParseInput = {
	documentId: "document-1",
	filename: "invoice.pdf",
	mimeType: "application/pdf",
	contentHash: "sha256:invoice",
	sourceUri: "memory://invoice.pdf",
};

const options: DurableParseOptions = {
	externalParserAllowed: false,
	idempotencyKey: "parse:document-1:generation-1",
	requestId: "request-1",
};

test("LiteParse normalizes digital PDF items instead of Markdown", async () => {
	const executor = fakeExecutor({
		pages: [
			{
				pageNum: 1,
				width: 612,
				height: 792,
				text: "金额 120000 元",
				markdown: "# Wrong canonical heading",
				textItems: [
					{
						text: "金额 120000 元",
						x: 20,
						y: 40,
						width: 120,
						height: 12,
					},
				],
				complexity: complexity(1, false),
			},
		],
		text: "# Wrong canonical heading",
	});
	const provider = providerWith(executor);

	const task = await provider.submit(input, options);
	const result = await eventuallyResult(provider, task.providerTaskId);

	assert.equal(result.document.nodes[0]?.text, "金额 120000 元");
	assert.equal(result.document.nodes[0]?.type, "paragraph");
	assert.deepEqual(result.document.nodes[0]?.meta.bbox, [20, 40, 120, 12]);
	assert.equal(result.report.metrics.canonical_source, "page_text_items");
	assert.equal(result.document.nodes[0]?.text.includes("Wrong"), false);
});

test("LiteParse fails closed when scanned PDF needs unavailable OCR", async () => {
	const executor = fakeExecutor({
		pages: [
			{
				pageNum: 1,
				width: 612,
				height: 792,
				text: "",
				textItems: [],
				complexity: complexity(1, true),
			},
		],
		text: "",
	});
	const provider = providerWith(executor, { ocrEnabled: false });

	const task = await provider.submit(input, options);
	const progress = await eventuallyTerminal(provider, task.providerTaskId);

	assert.equal(progress.status, "failed");
	assert.equal(progress.errorCode, "ocr_required");
	await assert.rejects(
		provider.fetchResult({
			documentId: input.documentId,
			providerTaskId: task.providerTaskId,
		}),
		(error: unknown) =>
			error instanceof LiteParseProviderError &&
			error.code === "ocr_required" &&
			!error.retryable,
	);
});

test("LiteParse marks partially low-confidence OCR as degraded", async () => {
	const executor = fakeExecutor({
		pages: [
			{
				pageNum: 1,
				width: 612,
				height: 792,
				text: "合同金额 10 万元",
				textItems: [
					{
						text: "合同金额",
						x: 10,
						y: 10,
						width: 50,
						height: 10,
						confidence: 0.95,
					},
					{
						text: "10 万元",
						x: 70,
						y: 10,
						width: 40,
						height: 10,
						confidence: 0.45,
					},
				],
				complexity: complexity(1, true),
			},
		],
		text: "合同金额 10 万元",
	});
	const provider = providerWith(executor, { ocrEnabled: true });

	const task = await provider.submit(input, options);
	const result = await eventuallyResult(provider, task.providerTaskId);

	assert.equal(result.report.mode, "degraded");
	assert.equal(result.report.partial, true);
	assert.deepEqual(result.report.failed_pages, [1]);
	assert.equal(result.report.metrics.low_confidence_item_count, 1);
});

test("LiteParse cancellation aborts queued or running execution", async () => {
	let observedAbort = false;
	const executor: LiteParseExecutor = {
		async inspect() {
			return [];
		},
		async parse(_source, execution) {
			await new Promise<void>((resolve) => {
				execution.signal.addEventListener(
					"abort",
					() => {
						observedAbort = true;
						resolve();
					},
					{ once: true },
				);
			});
			return { pages: [], text: "" };
		},
	};
	const provider = providerWith(executor);
	const task = await provider.submit(input, options);
	await eventuallyStatus(provider, task.providerTaskId, "running");

	await provider.cancel({
		documentId: input.documentId,
		providerTaskId: task.providerTaskId,
	});
	const progress = await provider.poll({
		documentId: input.documentId,
		providerTaskId: task.providerTaskId,
	});

	assert.equal(progress.status, "cancelled");
	assert.equal(observedAbort, true);
});

test("LiteParse classifies timeout as retryable", async () => {
	const executor: LiteParseExecutor = {
		async inspect() {
			return [];
		},
		async parse() {
			return new Promise<LiteParseOutput>(() => undefined);
		},
	};
	const provider = providerWith(executor, { timeoutMs: 10 });
	const task = await provider.submit(input, options);
	const progress = await eventuallyTerminal(provider, task.providerTaskId);

	assert.equal(progress.status, "failed");
	assert.equal(progress.errorCode, "provider_timeout");
	await assert.rejects(
		provider.fetchResult({
			documentId: input.documentId,
			providerTaskId: task.providerTaskId,
		}),
		(error: unknown) =>
			error instanceof LiteParseProviderError &&
			error.code === "provider_timeout" &&
			error.retryable,
	);
});

test("LiteParse classifies malformed parser failures", async () => {
	const executor: LiteParseExecutor = {
		async inspect() {
			return [];
		},
		async parse() {
			throw new Error("invalid PDF cross-reference table");
		},
	};
	const provider = providerWith(executor);
	const task = await provider.submit(input, options);
	const progress = await eventuallyTerminal(provider, task.providerTaskId);

	assert.equal(progress.status, "failed");
	assert.equal(progress.errorCode, "invalid_document");
});

test("LiteParse duplicate submit is idempotent and conflicting reuse fails", async () => {
	let executions = 0;
	const executor = fakeExecutor(
		{
			pages: [
				{
					pageNum: 1,
					width: 612,
					height: 792,
					text: "正文",
					textItems: [{ text: "正文", x: 1, y: 2, width: 3, height: 4 }],
					complexity: complexity(1, false),
				},
			],
			text: "正文",
		},
		() => {
			executions += 1;
		},
	);
	const provider = providerWith(executor);

	const first = await provider.submit(input, options);
	const duplicate = await provider.submit(input, options);
	assert.equal(duplicate.providerTaskId, first.providerTaskId);
	await eventuallyTerminal(provider, first.providerTaskId);
	assert.equal(executions, 1);

	await assert.rejects(
		provider.submit(
			{ ...input, documentId: "document-2", contentHash: "different" },
			options,
		),
		(error: unknown) =>
			error instanceof LiteParseProviderError &&
			error.code === "idempotency_conflict",
	);
});

test("LiteParse bounds concurrent local executions", async () => {
	let releaseFirst: (() => void) | undefined;
	const firstGate = new Promise<void>((resolve) => {
		releaseFirst = resolve;
	});
	let calls = 0;
	let active = 0;
	let maximumActive = 0;
	const output: LiteParseOutput = {
		pages: [
			{
				pageNum: 1,
				width: 612,
				height: 792,
				text: "正文",
				textItems: [{ text: "正文", x: 1, y: 2, width: 3, height: 4 }],
				complexity: complexity(1, false),
			},
		],
		text: "正文",
	};
	const executor: LiteParseExecutor = {
		async inspect() {
			return [];
		},
		async parse() {
			calls += 1;
			active += 1;
			maximumActive = Math.max(maximumActive, active);
			try {
				if (calls === 1) await firstGate;
				return output;
			} finally {
				active -= 1;
			}
		},
	};
	const provider = new LiteParseProvider({
		executor,
		maxConcurrency: 1,
		timeoutMs: 1_000,
		fetch: async () =>
			new Response(new Uint8Array([37, 80, 68, 70]), { status: 200 }),
	});

	const first = await provider.submit(input, options);
	const second = await provider.submit(input, {
		...options,
		idempotencyKey: "parse:document-1:generation-2",
		requestId: "request-2",
	});
	await eventuallyStatus(provider, first.providerTaskId, "running");
	assert.equal(
		(
			await provider.poll({
				documentId: input.documentId,
				providerTaskId: second.providerTaskId,
			})
		).status,
		"pending",
	);

	releaseFirst?.();
	await eventuallyTerminal(provider, first.providerTaskId);
	await eventuallyTerminal(provider, second.providerTaskId);
	assert.equal(maximumActive, 1);
});

function providerWith(
	executor: LiteParseExecutor,
	overrides: {
		timeoutMs?: number;
		ocrEnabled?: boolean;
	} = {},
): LiteParseProvider {
	return new LiteParseProvider({
		executor,
		timeoutMs: overrides.timeoutMs ?? 1_000,
		ocrEnabled: overrides.ocrEnabled,
		fetch: async () =>
			new Response(new Uint8Array([37, 80, 68, 70]), { status: 200 }),
	});
}

function fakeExecutor(
	output: LiteParseOutput,
	onParse?: () => void,
): LiteParseExecutor {
	return {
		async inspect() {
			return output.pages.flatMap((page) =>
				page.complexity ? [page.complexity] : [],
			);
		},
		async parse() {
			onParse?.();
			return output;
		},
	};
}

function complexity(pageNumber: number, needsOcr: boolean) {
	return {
		pageNumber,
		textLength: needsOcr ? 0 : 20,
		textCoverage: needsOcr ? 0 : 0.1,
		needsOcr,
		reasons: needsOcr ? ["scanned"] : [],
		layout: {
			columnCount: 1,
			ruledTableCount: 0,
			textTableRunCount: 0,
			figureCount: 0,
			isComplex: false,
			reasons: [],
		},
	};
}

async function eventuallyResult(
	provider: LiteParseProvider,
	providerTaskId: string,
) {
	await eventuallyTerminal(provider, providerTaskId);
	return provider.fetchResult({
		documentId: input.documentId,
		providerTaskId,
	});
}

async function eventuallyTerminal(
	provider: LiteParseProvider,
	providerTaskId: string,
) {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		const progress = await provider.poll({
			documentId: input.documentId,
			providerTaskId,
		});
		if (
			progress.status === "completed" ||
			progress.status === "failed" ||
			progress.status === "cancelled"
		) {
			return progress;
		}
		await new Promise((resolve) => setTimeout(resolve, 2));
	}
	throw new Error("LiteParse task did not reach a terminal state");
}

async function eventuallyStatus(
	provider: LiteParseProvider,
	providerTaskId: string,
	status: "pending" | "running",
) {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		const progress = await provider.poll({
			documentId: input.documentId,
			providerTaskId,
		});
		if (progress.status === status) return;
		await new Promise((resolve) => setTimeout(resolve, 2));
	}
	throw new Error(`LiteParse task did not reach ${status}`);
}
