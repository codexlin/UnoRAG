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
};

export class PdfDocumentParser {
	private readonly pollIntervalMs: number;
	private readonly maxWaitMs: number;

	constructor(private readonly options: PdfDocumentParserOptions) {
		this.pollIntervalMs = positiveInteger(options.pollIntervalMs, 250);
		this.maxWaitMs = positiveInteger(options.maxWaitMs, 15 * 60_000);
	}

	async parse(input: ParsePdfInput): Promise<DocumentIR> {
		await input.assertContinuing?.();
		let analysis = await this.options.liteParse.analyze(input.input);
		analysis = applyScanPolicy(analysis, input.policy.scanHandling);
		const providers = [
			this.options.liteParse,
			...(this.options.minerU ? [this.options.minerU] : []),
		];
		const decision = new ParserRouter(providers).route({
			input: input.input,
			analysis,
			deploymentPolicy: input.policy.deploymentPolicy,
			externalParserAllowed:
				Boolean(this.options.externalParserAllowed) &&
				input.policy.externalParserAllowed,
			preferredProviders:
				input.policy.parsePreference === "quality"
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
};

async function executeProvider(
	provider: DurableParserProvider,
	input: ExecuteProviderInput,
): Promise<ParseResult> {
	const submission = await provider.submit(input.input, {
		externalParserAllowed: input.externalParserAllowed,
		idempotencyKey: input.idempotencyKey,
		requestId: input.requestId,
	});
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
			const progress = await provider.poll(task);
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
		return provider.fetchResult(task);
	} catch (error) {
		await provider.cancel(task).catch(() => undefined);
		throw error;
	}
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
