import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { setImmediate } from "node:timers/promises";

import type {
	DocumentAnalysis,
	ParseInput,
	ParserCapabilities,
	ProviderTask,
} from "../../src/core/contracts";
import {
	DocumentIRSchema,
	ParserReportSchema,
} from "../../src/core/document-ir";
import { buildIndexPayloads, chunkDocument } from "../../src/core/ingest";
import {
	type DurableParserProvider,
	PdfDocumentParser,
} from "../../src/core/parsing";
import type {
	ParserBudgetExhaustion,
	ParserProviderAttempt,
} from "../../src/core/parsing/document-parser";
import { ParserProviderHttpError } from "../../src/core/parsing/http-parser-provider";
import { projectParserTiming } from "../../src/core/parsing/parser-diagnostics";

const parseInput: ParseInput = {
	documentId: "document-1",
	filename: "contract.pdf",
	mimeType: "application/pdf",
	contentHash: "sha256:fixture",
	sourceUri: "storage://documents/contract.pdf",
};

test("PDF diagnostics separate analysis, submission, observed wait and result fetch", async () => {
	const attempts: ParserProviderAttempt[] = [];
	const local = provider("liteparse", { tables: false, calls: [] });
	local.submit = async () => ({
		providerTaskId: "private-task-id",
		status: "pending",
		submittedAt: new Date().toISOString(),
	});
	let polls = 0;
	local.poll = async () => ({
		status: ++polls === 1 ? "running" : "completed",
	});
	const parsed = await new PdfDocumentParser({
		liteParse: local,
		pollIntervalMs: 1,
		onProviderAttempt: (attempt) => attempts.push(attempt),
	}).parse(parseRequest("timed"));
	const timing = projectParserTiming(
		parsed.parser_report.metrics.parser_timing,
	);
	assert.ok(timing);
	assert.equal(timing.poll_count, 2);
	assert.equal(timing.retry_count, 0);
	for (const value of [
		timing.analysis_ms,
		timing.submission_ms,
		timing.provider_wait_ms,
		timing.result_fetch_ms,
	])
		assert.ok(Number.isFinite(value) && value >= 0);
	assert.deepEqual(
		attempts.map(({ operation, status }) => [operation, status]),
		[
			["submit", "pending"],
			["poll", "running"],
			["poll", "completed"],
			["fetch", "completed"],
		],
	);
	assert.ok(
		attempts.every(
			(attempt) =>
				attempt.requestId === "request-timed" &&
				attempt.documentId === parseInput.documentId,
		),
	);
	const refs = attempts
		.filter((attempt) => attempt.operation !== "submit")
		.map((attempt) => attempt.providerTaskRef);
	assert.equal(new Set(refs).size, 1);
	assert.match(refs[0] ?? "", /^[a-f0-9]{16}$/);
	assert.ok(!JSON.stringify(attempts).includes("private-task-id"));
	assert.ok(!JSON.stringify(attempts).includes(parseInput.sourceUri));
});

test("parser diagnostic context stays isolated across concurrent documents and retries", async () => {
	const attempts: ParserProviderAttempt[] = [];
	const local = provider("liteparse", { tables: false, calls: [] });
	local.submit = async (input) => ({
		providerTaskId: `task-${input.documentId}`,
		status: "running",
		submittedAt: new Date().toISOString(),
	});
	const polls = new Map<string, number>();
	local.poll = async (task) => {
		const count = (polls.get(task.documentId) ?? 0) + 1;
		polls.set(task.documentId, count);
		if (count === 1)
			throw new ParserProviderHttpError({
				code: "provider_service_error",
				message: "private upstream response",
				retryable: true,
				status: 503,
			});
		return { status: "completed" };
	};
	const parser = new PdfDocumentParser({
		liteParse: local,
		retryBackoffMs: [0],
		onProviderAttempt: (attempt) => attempts.push(attempt),
	});
	const results = await Promise.all(
		["a", "b"].map((id) =>
			parser.parse({
				...parseRequest(id),
				input: { ...parseInput, documentId: id },
			}),
		),
	);
	for (const [index, id] of ["a", "b"].entries()) {
		const own = attempts.filter((attempt) => attempt.documentId === id);
		assert.ok(own.every((attempt) => attempt.requestId === `request-${id}`));
		assert.equal(
			projectParserTiming(results[index].parser_report.metrics.parser_timing)
				?.retry_count,
			1,
		);
		assert.equal(
			new Set(own.flatMap((attempt) => attempt.providerTaskRef ?? [])).size,
			1,
		);
	}
	assert.equal(
		new Set(attempts.flatMap((attempt) => attempt.providerTaskRef ?? [])).size,
		2,
	);
	assert.ok(!JSON.stringify(attempts).includes("private upstream response"));
});

test("parser timing projection ignores old reports and rejects malformed or nonfinite metrics", () => {
	assert.equal(projectParserTiming(undefined), null);
	const valid = {
		schema_version: 1,
		analysis_ms: 1,
		submission_ms: 2,
		provider_wait_ms: 3,
		result_fetch_ms: 4,
		poll_count: 2,
		retry_count: 0,
	};
	assert.deepEqual(projectParserTiming({ ...valid, url: "private" }), valid);
	for (const value of [NaN, Infinity, -1, "1"])
		assert.equal(
			projectParserTiming({ ...valid, provider_wait_ms: value }),
			null,
		);
	assert.equal(projectParserTiming({ ...valid, poll_count: 1.5 }), null);
});

test("observed parser timings never change index records or their replay manifest", async () => {
	const local = provider("liteparse", { tables: false, calls: [] });
	const document = await new PdfDocumentParser({ liteParse: local }).parse(
		parseRequest("stable-records"),
	);
	const later = structuredClone(document);
	later.parser_report.metrics.parser_timing = {
		schema_version: 1,
		analysis_ms: 99,
		submission_ms: 100,
		provider_wait_ms: 999,
		result_fetch_ms: 55,
		poll_count: 5,
		retry_count: 2,
	};
	const scope = {
		documentId: parseInput.documentId,
		documentVersionId: "version-1",
		generationId: "10000000-0000-4000-8000-000000000001",
		organizationId: "org-1",
		workspaceId: "workspace-1",
		libraryId: "library-1",
	};
	assert.deepEqual(
		buildIndexPayloads(await chunkDocument(document), scope),
		buildIndexPayloads(await chunkDocument(later), scope),
	);
});

test("PDF quality routing selects MinerU for complex tables and normalizes scope", async () => {
	const calls: string[] = [];
	const liteParse = provider("liteparse", {
		tables: false,
		analysis: {
			hasTextLayer: true,
			needsOcr: false,
			hasTables: true,
			hasFigures: false,
			complexityScore: 0.9,
			warnings: [],
		},
		calls,
	});
	const minerU = provider("mineru", { tables: true, calls });
	const parser = new PdfDocumentParser({
		liteParse,
		minerU,
		pollIntervalMs: 1,
		maxWaitMs: 100,
	});

	const document = await parser.parse({
		input: parseInput,
		libraryId: "library-1",
		title: "Contract",
		idempotencyKey: "ingest-1",
		requestId: "request-1",
		policy: {
			deploymentPolicy: "private-preferred",
			externalParserAllowed: false,
			parsePreference: "quality",
			scanHandling: "auto",
		},
	});

	assert.ok(calls.includes("mineru:submit"));
	assert.ok(!calls.includes("liteparse:submit"));
	assert.equal(document.library_id, "library-1");
	assert.equal(document.title, "Contract");
	assert.equal(document.content_hash, parseInput.contentHash);
});

test("PDF auto routing keeps simple digital files on LiteParse", async () => {
	const calls: string[] = [];
	const liteParse = provider("liteparse", { tables: false, calls });
	const minerU = provider("mineru", { tables: true, calls });
	const parser = new PdfDocumentParser({
		liteParse,
		minerU,
		pollIntervalMs: 1,
		maxWaitMs: 100,
	});

	await parser.parse({
		input: parseInput,
		libraryId: "library-1",
		title: "Contract",
		idempotencyKey: "ingest-2",
		requestId: "request-2",
		policy: {
			deploymentPolicy: "private-preferred",
			externalParserAllowed: false,
			parsePreference: "auto",
			scanHandling: "auto",
		},
	});

	assert.ok(calls.includes("liteparse:submit"));
	assert.ok(!calls.includes("mineru:submit"));
});

for (const scenario of [
	{ name: "default 250ms interval", pollIntervalMs: undefined, delayMs: 250 },
	{ name: "minimum 25ms interval", pollIntervalMs: 1, delayMs: 25 },
	{ name: "configured 5s interval", pollIntervalMs: 5_000, delayMs: 5_000 },
	{
		name: "provider Retry-After 60s",
		pollIntervalMs: 5_000,
		retryAfterMs: 60_000,
		delayMs: 60_000,
	},
]) {
	test(`PDF polling preserves ${scenario.name} on the same task`, async (context) => {
		const advance = parserClock(context);
		const local = provider("liteparse", { tables: false, calls: [] });
		const submit = context.mock.method(local, "submit", async () => ({
			providerTaskId: "stable-task",
			status: "running" as const,
			submittedAt: new Date().toISOString(),
		}));
		const pollTimes: number[] = [];
		context.mock.method(local, "poll", async (task: ProviderTask) => {
			assert.equal(task.providerTaskId, "stable-task");
			pollTimes.push(Date.now());
			return {
				status: pollTimes.length === 1 ? "running" : "completed",
				retryAfterMs:
					"retryAfterMs" in scenario ? scenario.retryAfterMs : undefined,
			};
		});
		const fetch = context.mock.method(local, "fetchResult");
		const cancel = context.mock.method(local, "cancel");
		const pending = new PdfDocumentParser({
			liteParse: local,
			pollIntervalMs: scenario.pollIntervalMs,
			maxWaitMs: 90_000,
		}).parse(parseRequest("poll-delay"));
		await advance(0);
		assert.deepEqual(pollTimes, [0]);
		await advance(scenario.delayMs - 1);
		assert.deepEqual(pollTimes, [0]);
		assert.equal(fetch.mock.callCount(), 0);
		await advance(1);
		await pending;
		assert.deepEqual(pollTimes, [0, scenario.delayMs]);
		assert.equal(submit.mock.callCount(), 1);
		assert.equal(fetch.mock.callCount(), 1);
		assert.equal(
			fetch.mock.calls[0].arguments[0].providerTaskId,
			"stable-task",
		);
		assert.equal(cancel.mock.callCount(), 0);
	});
}

test("PDF polling cancellation interrupts a long wait without another poll", async (context) => {
	const advance = parserClock(context);
	const local = provider("liteparse", { tables: false, calls: [] });
	const submit = context.mock.method(local, "submit", async () => ({
		providerTaskId: "stable-task",
		status: "running" as const,
		submittedAt: new Date().toISOString(),
	}));
	const poll = context.mock.method(
		local,
		"poll",
		async (task: ProviderTask) => {
			assert.equal(task.providerTaskId, "stable-task");
			return { status: "running" as const, retryAfterMs: 60_000 };
		},
	);
	const fetch = context.mock.method(local, "fetchResult");
	const cancel = context.mock.method(local, "cancel");
	let cancelled = false;
	let settled = false;
	const reason = Object.assign(new Error("job cancelled"), {
		code: "job_cancelled",
	});
	const pending = new PdfDocumentParser({
		liteParse: local,
		maxWaitMs: 90_000,
	}).parse({
		...parseRequest("poll-cancel"),
		async assertContinuing() {
			if (cancelled) throw reason;
		},
	});
	const rejected = assert.rejects(pending, (error) => {
		settled = true;
		return error === reason;
	});
	await advance(1_123);
	cancelled = true;
	await advance(126);
	assert.equal(settled, false);
	await advance(1);
	await rejected;
	assert.equal(Date.now(), 1_250);
	assert.equal(submit.mock.callCount(), 1);
	assert.equal(poll.mock.callCount(), 1);
	assert.equal(fetch.mock.callCount(), 0);
	assert.equal(cancel.mock.callCount(), 1);
	assert.equal(cancel.mock.calls[0].arguments[0].providerTaskId, "stable-task");
	await advance(60_000);
	assert.equal(poll.mock.callCount(), 1);
	assert.equal(fetch.mock.callCount(), 0);
});

test("PDF polling wait expires at the original deadline without another poll", async (context) => {
	const advance = parserClock(context);
	const exhausted: ParserBudgetExhaustion[] = [];
	const local = provider("liteparse", { tables: false, calls: [] });
	const submit = context.mock.method(local, "submit", async () => {
		await new Promise((resolve) => setTimeout(resolve, 500));
		return {
			providerTaskId: "stable-task",
			status: "running" as const,
			submittedAt: new Date().toISOString(),
		};
	});
	const poll = context.mock.method(
		local,
		"poll",
		async (task: ProviderTask) => {
			assert.equal(task.providerTaskId, "stable-task");
			return { status: "pending" as const, retryAfterMs: 60_000 };
		},
	);
	const fetch = context.mock.method(local, "fetchResult");
	const cancel = context.mock.method(local, "cancel");
	let settled = false;
	const pending = new PdfDocumentParser({
		liteParse: local,
		maxWaitMs: 1_751,
		onBudgetExhausted: (observation) => exhausted.push(observation),
	}).parse(parseRequest("poll-deadline"));
	const rejected = assert.rejects(pending, (error) => {
		settled = true;
		assert.equal((error as { code: string }).code, "parser_budget_exhausted");
		assert.equal((error as { retryable: boolean }).retryable, false);
		return true;
	});
	await advance(0);
	await advance(500);
	assert.equal(poll.mock.callCount(), 1);
	assert.equal(poll.mock.calls[0].arguments[0].providerTaskId, "stable-task");
	await advance(1_250);
	assert.equal(settled, false);
	await advance(1);
	await rejected;
	assert.equal(Date.now(), 1_751);
	assert.equal(submit.mock.callCount(), 1);
	assert.equal(poll.mock.callCount(), 1);
	assert.equal(fetch.mock.callCount(), 0);
	assert.equal(cancel.mock.callCount(), 0);
	assert.equal(exhausted.length, 1);
	assert.equal(exhausted[0].budgetMs, 1_751);
	assert.equal(exhausted[0].provider, "liteparse");
	assert.equal(exhausted[0].documentId, parseInput.documentId);
	assert.equal(exhausted[0].pollCount, 1);
	assert.equal(exhausted[0].retryCount, 0);
	assert.ok(exhausted[0].elapsedMs >= 0);
	assert.ok(!JSON.stringify(exhausted).includes(parseInput.sourceUri));
	assert.ok(!JSON.stringify(exhausted).includes("stable-task"));
	await advance(60_000);
	assert.equal(poll.mock.callCount(), 1);
	assert.equal(fetch.mock.callCount(), 0);
});

test("PDF parser cancels the provider task when the ingest cohort is cancelled", async () => {
	const calls: string[] = [];
	const liteParse = provider("liteparse", { tables: false, calls });
	liteParse.submit = async () => {
		calls.push("liteparse:submit");
		return {
			providerTaskId: "liteparse-task",
			status: "running",
			submittedAt: new Date(0).toISOString(),
		};
	};
	liteParse.poll = async () => {
		calls.push("liteparse:poll");
		return { status: "running", retryAfterMs: 1 };
	};
	const parser = new PdfDocumentParser({
		liteParse,
		pollIntervalMs: 1,
		maxWaitMs: 100,
	});
	let continuationChecks = 0;

	await assert.rejects(
		() =>
			parser.parse({
				input: parseInput,
				libraryId: "library-1",
				title: "Contract",
				idempotencyKey: "ingest-cancel",
				requestId: "request-cancel",
				policy: {
					deploymentPolicy: "strict-private",
					externalParserAllowed: false,
					parsePreference: "auto",
					scanHandling: "auto",
				},
				async assertContinuing() {
					continuationChecks += 1;
					if (continuationChecks >= 5) throw new Error("job cancelled");
				},
			}),
		/job cancelled/,
	);

	assert.ok(calls.includes("liteparse:poll"));
	assert.ok(calls.includes("liteparse:cancel"));
	assert.ok(!calls.includes("liteparse:fetch"));
});

test("late retryable provider failure is terminal even before the deadline timer runs", async (context) => {
	let now = 0;
	context.mock.method(Date, "now", () => now);
	const local = provider("liteparse", { tables: false, calls: [] });
	local.submit = async () => ({
		providerTaskId: "private-task",
		status: "running",
		submittedAt: new Date().toISOString(),
	});
	local.poll = async () => {
		now = 26;
		throw new ParserProviderHttpError({
			code: "provider_service_error",
			message: "private upstream body",
			retryable: true,
			status: 503,
		});
	};
	const observed: ParserBudgetExhaustion[] = [];
	await assert.rejects(
		new PdfDocumentParser({
			liteParse: local,
			maxWaitMs: 25,
			onBudgetExhausted(observation) {
				observed.push(observation);
				throw new Error("diagnostics unavailable");
			},
		}).parse(parseRequest("late-provider-error")),
		{ code: "parser_budget_exhausted", retryable: false },
	);
	assert.equal(observed.length, 1);
	assert.equal(observed[0].pollCount, 1);
	assert.equal(observed[0].retryCount, 0);
	assert.ok(!JSON.stringify(observed).includes("private"));
});

test("late permanent errors and caller cancellation retain their original identity", async (context) => {
	let now = 0;
	context.mock.method(Date, "now", () => now);
	for (const reason of [
		new ParserProviderHttpError({
			code: "provider_unauthorized",
			message: "invalid credential",
			retryable: false,
			status: 401,
		}),
		Object.assign(new Error("cancelled"), {
			code: "job_cancelled",
			retryable: false,
		}),
	]) {
		now = 0;
		const local = provider("liteparse", { tables: false, calls: [] });
		local.submit = async () => ({
			providerTaskId: "stable",
			status: "running",
			submittedAt: new Date().toISOString(),
		});
		local.poll = async () => {
			now = 26;
			throw reason;
		};
		await assert.rejects(
			new PdfDocumentParser({ liteParse: local, maxWaitMs: 25 }).parse(
				parseRequest("late-permanent"),
			),
			(error) => error === reason,
		);
	}
});

test("PDF parser retries transient submit failures with the same idempotency key", async () => {
	const calls: string[] = [];
	const attempts: Array<{ outcome: string; operation: string }> = [];
	const liteParse = provider("liteparse", { tables: false, calls });
	let submissions = 0;
	const keys: string[] = [];
	liteParse.submit = async (_input, options) => {
		submissions += 1;
		keys.push(options.idempotencyKey);
		if (submissions === 1) {
			throw new ParserProviderHttpError({
				message: "busy",
				code: "provider_service_error",
				retryable: true,
				status: 503,
			});
		}
		return {
			providerTaskId: "stable-task",
			status: "completed",
			submittedAt: new Date(0).toISOString(),
		};
	};
	const parser = new PdfDocumentParser({
		liteParse,
		retryBackoffMs: [0],
		random: () => 0.5,
		onProviderAttempt: (attempt) => attempts.push(attempt),
	});

	await parser.parse(parseRequest("ingest-retry-submit"));

	assert.equal(submissions, 2);
	assert.equal(new Set(keys).size, 1);
	assert.deepEqual(
		attempts.map(({ operation, outcome }) => [operation, outcome]),
		[
			["submit", "retry"],
			["submit", "success"],
			["fetch", "success"],
		],
	);
});

test("PDF parser retries polling without cancelling or resubmitting the remote task", async () => {
	const calls: string[] = [];
	const liteParse = provider("liteparse", { tables: false, calls });
	let polls = 0;
	liteParse.submit = async () => ({
		providerTaskId: "stable-task",
		status: "running",
		submittedAt: new Date(0).toISOString(),
	});
	liteParse.poll = async () => {
		polls += 1;
		if (polls === 1) {
			throw new ParserProviderHttpError({
				message: "rate limited",
				code: "provider_rate_limited",
				retryable: true,
				status: 429,
				retryAfterMs: 0,
			});
		}
		return { status: "completed" };
	};
	const parser = new PdfDocumentParser({
		liteParse,
		retryBackoffMs: [0],
		pollIntervalMs: 1,
		maxWaitMs: 100,
	});

	await parser.parse(parseRequest("ingest-retry-poll"));

	assert.equal(polls, 2);
	assert.ok(!calls.includes("liteparse:cancel"));
});

test("PDF parser bounds provider retry delays by the workflow deadline", async () => {
	const calls: string[] = [];
	const liteParse = provider("liteparse", { tables: false, calls });
	liteParse.submit = async () => ({
		providerTaskId: "slow-task",
		status: "running",
		submittedAt: new Date(0).toISOString(),
	});
	liteParse.poll = async () => {
		throw new ParserProviderHttpError({
			message: "rate limited",
			code: "provider_rate_limited",
			retryable: true,
			status: 429,
			retryAfterMs: 60_000,
		});
	};
	const parser = new PdfDocumentParser({
		liteParse,
		retryBackoffMs: [60_000],
		maxWaitMs: 10,
	});
	const startedAt = performance.now();

	await assert.rejects(
		() => parser.parse(parseRequest("ingest-retry-deadline")),
		{ code: "parser_budget_exhausted", retryable: false },
	);
	assert.ok(performance.now() - startedAt < 500);
	assert.ok(!calls.includes("liteparse:cancel"));
});

function parserClock(context: TestContext) {
	context.mock.timers.enable({
		apis: ["Date", "setTimeout", "setInterval"],
		now: 0,
	});
	return async (milliseconds: number) => {
		for (let remaining = milliseconds; remaining > 0; ) {
			const step = Math.min(remaining, 250);
			context.mock.timers.tick(step);
			await setImmediate();
			remaining -= step;
		}
		await setImmediate();
	};
}

function parseRequest(idempotencyKey: string) {
	return {
		input: parseInput,
		libraryId: "library-1",
		title: "Contract",
		idempotencyKey,
		requestId: `request-${idempotencyKey}`,
		policy: {
			deploymentPolicy: "strict-private" as const,
			externalParserAllowed: false,
			parsePreference: "auto" as const,
			scanHandling: "auto" as const,
		},
	};
}

function provider(
	name: string,
	options: {
		tables: boolean;
		calls: string[];
		analysis?: DocumentAnalysis;
	},
): DurableParserProvider {
	const capabilities: ParserCapabilities = {
		formats: ["pdf"],
		ocr: true,
		tables: options.tables,
		figures: options.tables,
		boundingBoxes: true,
		asynchronous: true,
		externalDataProcessing: false,
	};
	return {
		name,
		version: "test",
		capabilities,
		async analyze() {
			options.calls.push(`${name}:analyze`);
			return (
				options.analysis ?? {
					hasTextLayer: true,
					needsOcr: false,
					hasTables: false,
					hasFigures: false,
					complexityScore: 0.1,
					warnings: [],
				}
			);
		},
		async submit(_input, submitOptions) {
			options.calls.push(`${name}:submit`);
			assert.match(submitOptions.idempotencyKey, new RegExp(name));
			return {
				providerTaskId: `${name}-task`,
				status: "completed",
				submittedAt: new Date(0).toISOString(),
			};
		},
		async poll() {
			throw new Error("completed submissions must not be polled");
		},
		async fetchResult() {
			options.calls.push(`${name}:fetch`);
			const report = ParserReportSchema.parse({
				source_format: "pdf",
				parser: name,
				backend: name,
				parser_version: "test",
				mode: "structured",
			});
			return {
				document: DocumentIRSchema.parse({
					id: "wrong-id",
					source_format: "pdf",
					title: "wrong title",
					filename: parseInput.filename,
					nodes: [{ id: "node-1", type: "paragraph", text: "Evidence" }],
					parser_report: report,
				}),
				report,
			};
		},
		async cancel() {
			options.calls.push(`${name}:cancel`);
		},
	};
}
