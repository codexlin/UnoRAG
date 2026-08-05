import type {
	DocumentAnalysis,
	ParseInput,
	ParseProgress,
	ParseResult,
	ProviderTask,
} from "../contracts";
import { type DocumentIR, DocumentIRSchema } from "../document-ir";
import type { DurableParserProvider } from "./http-parser-provider";
import { ParserRouter } from "./parser-router";

export type ParserProviderOperation = "submit" | "poll" | "fetch";
export type ParserProviderAttempt = Readonly<{
	provider: string;
	operation: ParserProviderOperation;
	attempt: number;
	outcome: "success" | "retry" | "failed";
	durationMs: number;
	errorCode?: string;
	httpStatus?: number;
	retryDelayMs?: number;
}>;

export type PdfParsePolicy = {
	deploymentPolicy: "strict-private" | "private-preferred" | "cloud-allowed";
	externalParserAllowed: boolean;
	parsePreference: "auto" | "quality" | "local_only";
	scanHandling: "auto" | "force_ocr" | "disabled";
};

export type ParsePdfInput = {
	input: ParseInput;
	libraryId: string;
	title: string;
	idempotencyKey: string;
	requestId: string;
	policy: PdfParsePolicy;
	assertContinuing?: () => Promise<void>;
};

export type PdfDocumentParserOptions = {
	liteParse: DurableParserProvider;
	minerU?: DurableParserProvider;
	externalParserAllowed?: boolean;
	pollIntervalMs?: number;
	maxWaitMs?: number;
	retryBackoffMs?: readonly number[];
	random?: () => number;
	onProviderAttempt?: (attempt: ParserProviderAttempt) => void;
};

export class PdfDocumentParser {
	private readonly pollIntervalMs: number;
	private readonly maxWaitMs: number;
	private readonly retryBackoffMs: readonly number[];
	private readonly random: () => number;

	constructor(private readonly options: PdfDocumentParserOptions) {
		this.pollIntervalMs = positiveInteger(options.pollIntervalMs, 250);
		this.maxWaitMs = positiveInteger(options.maxWaitMs, 15 * 60_000);
		this.retryBackoffMs = options.retryBackoffMs ?? [
			2_000, 5_000, 15_000, 30_000,
		];
		this.random = options.random ?? Math.random;
	}

	async parse(input: ParsePdfInput): Promise<DocumentIR> {
		await input.assertContinuing?.();
		let analysis = await this.options.liteParse.analyze(input.input);
		analysis = applyScanPolicy(analysis, input.policy.scanHandling);
		const providers = [
			this.options.liteParse,
			...(this.options.minerU ? [this.options.minerU] : []),
		];
		const prefersEnhancedParser =
			input.policy.parsePreference === "quality" ||
			analysis.needsOcr ||
			analysis.hasTables ||
			analysis.hasFigures ||
			analysis.complexityScore >= 0.7;
		const decision = new ParserRouter(providers).route({
			input: input.input,
			analysis,
			deploymentPolicy: input.policy.deploymentPolicy,
			externalParserAllowed:
				Boolean(this.options.externalParserAllowed) &&
				input.policy.externalParserAllowed,
			preferredProviders: prefersEnhancedParser
				? ["mineru", "liteparse"]
				: ["liteparse", "mineru"],
		});
		const result = await executeProvider(decision.provider, {
			input: input.input,
			idempotencyKey: `${input.idempotencyKey}:parser:${decision.provider.name}`,
			requestId: input.requestId,
			externalParserAllowed:
				Boolean(this.options.externalParserAllowed) &&
				input.policy.externalParserAllowed,
			assertContinuing: input.assertContinuing,
			pollIntervalMs: this.pollIntervalMs,
			maxWaitMs: this.maxWaitMs,
			retryBackoffMs: this.retryBackoffMs,
			random: this.random,
			onProviderAttempt: this.options.onProviderAttempt,
		});
		return normalizeResult(result, input);
	}
}

type ExecuteProviderInput = {
	input: ParseInput;
	idempotencyKey: string;
	requestId: string;
	externalParserAllowed: boolean;
	assertContinuing?: () => Promise<void>;
	pollIntervalMs: number;
	maxWaitMs: number;
	retryBackoffMs: readonly number[];
	random: () => number;
	onProviderAttempt?: (attempt: ParserProviderAttempt) => void;
};

async function executeProvider(
	provider: DurableParserProvider,
	input: ExecuteProviderInput,
): Promise<ParseResult> {
	const submission = await retryProviderOperation(
		provider,
		"submit",
		input,
		() =>
			provider.submit(input.input, {
				externalParserAllowed: input.externalParserAllowed,
				idempotencyKey: input.idempotencyKey,
				requestId: input.requestId,
			}),
	);
	const task: ProviderTask = {
		providerTaskId: submission.providerTaskId,
		documentId: input.input.documentId,
	};
	const deadline = Date.now() + input.maxWaitMs;
	try {
		let status: ParseProgress["status"] = submission.status;
		while (status !== "completed") {
			await input.assertContinuing?.();
			if (Date.now() >= deadline) {
				throw parserError(
					"provider_timeout",
					`${provider.name} exceeded its parser workflow timeout`,
					true,
				);
			}
			const progress = await retryProviderOperation(
				provider,
				"poll",
				input,
				() => provider.poll(task),
				deadline,
			);
			status = progress.status;
			if (status === "failed") {
				throw parserError(
					progress.errorCode || "provider_failed",
					`${provider.name} parser task failed`,
					false,
				);
			}
			if (status === "cancelled") {
				throw parserError(
					"provider_cancelled",
					`${provider.name} parser task was cancelled`,
					false,
				);
			}
			if (status !== "completed") {
				await cancellableDelay(
					Math.min(
						Math.max(progress.retryAfterMs ?? input.pollIntervalMs, 25),
						1_000,
					),
					input.assertContinuing,
				);
			}
		}
		await input.assertContinuing?.();
		return retryProviderOperation(
			provider,
			"fetch",
			input,
			() => provider.fetchResult(task),
			deadline,
		);
	} catch (error) {
		if (!retryMetadata(error).retryable) {
			await provider.cancel(task).catch(() => undefined);
		}
		throw error;
	}
}

async function retryProviderOperation<T>(
	provider: DurableParserProvider,
	operation: ParserProviderOperation,
	input: ExecuteProviderInput,
	run: () => Promise<T>,
	deadline?: number,
): Promise<T> {
	for (let attempt = 1; ; attempt += 1) {
		await input.assertContinuing?.();
		if (deadline !== undefined && Date.now() >= deadline) {
			throw parserError(
				"provider_timeout",
				`${provider.name} exceeded its parser workflow timeout`,
				true,
			);
		}
		const startedAt = performance.now();
		try {
			const result = await run();
			input.onProviderAttempt?.({
				provider: provider.name,
				operation,
				attempt,
				outcome: "success",
				durationMs: elapsedMilliseconds(startedAt),
			});
			return result;
		} catch (error) {
			const metadata = retryMetadata(error);
			const canRetry =
				metadata.retryable && attempt <= input.retryBackoffMs.length;
			const delayMs = canRetry
				? retryDelay(
						input.retryBackoffMs[attempt - 1] ?? 0,
						metadata.retryAfterMs,
						input.random,
					)
				: undefined;
			input.onProviderAttempt?.({
				provider: provider.name,
				operation,
				attempt,
				outcome: canRetry ? "retry" : "failed",
				durationMs: elapsedMilliseconds(startedAt),
				errorCode: metadata.code,
				httpStatus: metadata.status ?? undefined,
				retryDelayMs: delayMs,
			});
			if (!canRetry) throw error;
			const boundedDelay =
				deadline === undefined
					? (delayMs ?? 0)
					: Math.min(delayMs ?? 0, Math.max(0, deadline - Date.now()));
			await cancellableDelay(boundedDelay, input.assertContinuing);
		}
	}
}

function retryMetadata(error: unknown): {
	code: string;
	retryable: boolean;
	status: number | null;
	retryAfterMs?: number;
} {
	if (!error || typeof error !== "object") {
		return { code: "provider_unknown_error", retryable: false, status: null };
	}
	const value = error as Record<string, unknown>;
	return {
		code:
			typeof value.code === "string" ? value.code : "provider_unknown_error",
		retryable: value.retryable === true,
		status: typeof value.status === "number" ? value.status : null,
		retryAfterMs:
			typeof value.retryAfterMs === "number" && value.retryAfterMs >= 0
				? value.retryAfterMs
				: undefined,
	};
}

function retryDelay(
	backoffMs: number,
	retryAfterMs: number | undefined,
	random: () => number,
): number {
	if (retryAfterMs !== undefined) return retryAfterMs;
	const jitter = 0.8 + Math.min(1, Math.max(0, random())) * 0.4;
	return Math.round(backoffMs * jitter);
}

function elapsedMilliseconds(startedAt: number): number {
	return Math.max(0, Math.round((performance.now() - startedAt) * 100) / 100);
}

function normalizeResult(
	result: ParseResult,
	input: ParsePdfInput,
): DocumentIR {
	return DocumentIRSchema.parse({
		...result.document,
		id: input.input.documentId,
		library_id: input.libraryId,
		source: input.input.sourceUri,
		source_format: "pdf",
		title: input.title,
		filename: input.input.filename,
		content_hash: input.input.contentHash,
		parser_report: result.report,
	});
}

function applyScanPolicy(
	analysis: DocumentAnalysis,
	policy: PdfParsePolicy["scanHandling"],
): DocumentAnalysis {
	if (policy === "disabled" && analysis.needsOcr) {
		throw parserError(
			"ocr_disabled",
			"PDF requires OCR but scan handling is disabled",
			false,
		);
	}
	if (policy === "force_ocr") {
		return {
			...analysis,
			needsOcr: true,
			warnings: [...analysis.warnings, "OCR forced by document policy"],
		};
	}
	return analysis;
}

async function cancellableDelay(
	milliseconds: number,
	assertContinuing?: () => Promise<void>,
): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, milliseconds));
	await assertContinuing?.();
}

function parserError(code: string, message: string, retryable: boolean): Error {
	return Object.assign(new Error(message), { code, retryable });
}

function positiveInteger(value: number | undefined, fallback: number): number {
	return Number.isInteger(value) && Number(value) > 0
		? Number(value)
		: fallback;
}
