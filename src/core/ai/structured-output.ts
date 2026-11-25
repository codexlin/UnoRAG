import {
	APICallError,
	generateText,
	type LanguageModel,
	type ModelMessage,
	NoObjectGeneratedError,
	NoOutputGeneratedError,
	Output,
	RetryError,
} from "ai";
import { z } from "zod";
import { metadataOnlyAiTelemetry } from "@/lib/observability/ai-telemetry";
import { withActiveSpan } from "@/lib/observability/tracing";
import {
	ConflictEvidenceSchema,
	validateConflictEvidence,
} from "../ask-graph/evidence-conflict";
import { type TableQueryPlan, TableQueryPlanSchema } from "../ask-graph/table";
import {
	type AiConcurrencyGateLike,
	AiConcurrencyOverloadedError,
	AiConcurrencyWaitTimeoutError,
} from "./concurrency-gate";
import { createConflictExcerpts } from "./conflict-excerpts";
import {
	type ModelUsageObservation,
	type ModelUsageRecorder,
	type ModelUsageTokens,
	normalizeModelUsage,
	startModelUsageAttempt,
} from "./model-usage";
import {
	getPrompt,
	promptSpanAttributes,
	type VersionedPrompt,
} from "./prompt-registry";

const STRUCTURED_TEMPERATURE = 0;

export const QueryTypeSchema = z.enum([
	"fact",
	"follow_up",
	"summary",
	"compare",
	"table",
	"section_lookup",
	"ambiguous",
]);

export const RouterOutputSchema = z
	.object({
		query_type: QueryTypeSchema,
		reason: z.string().trim().min(1),
	})
	.strict();

export const RewriteOutputSchema = z
	.object({
		resolution: z.enum(["standalone", "resolved", "ambiguous"]),
		subjects: z.array(z.string().trim().min(1).max(120)).max(4),
	})
	.strict();

export const JudgeOutputSchema = z
	.object({
		reason: z.string().trim().min(1),
		sufficient: z.boolean(),
		action: z.enum(["generate", "retry", "refuse"]),
		evidence_ids: z.array(z.string().trim().min(1)).max(6),
		can_retry: z.boolean().optional(),
		top_score: z.number().min(0).max(1).optional(),
		missing_query: z.string().trim().max(120).optional(),
	})
	.strict();

const RefusalReviewOutputSchema = z
	.object({
		missing_requirements: z.array(z.string().trim().min(1).max(240)).max(8),
		excerpts: ConflictEvidenceSchema,
	})
	.strict();

export const ConflictOutputSchema = z
	.object({
		comparison: z.string().trim().min(1).max(800),
		resolution: z.enum(["consistent", "scoped", "precedence", "conflict"]),
		conflict_evidence: ConflictEvidenceSchema.describe(
			"Empty unless resolution is conflict; otherwise include exact source quotes from both sides.",
		),
	})
	.strict()
	.refine(
		(value) =>
			(value.resolution === "conflict") === value.conflict_evidence.length > 0,
		"Inconsistent conflict resolution",
	);

export const ConflictSelectionOutputSchema = z
	.object({
		comparison: z.string().trim().min(1).max(800),
		resolution: z.enum(["consistent", "scoped", "precedence", "conflict"]),
		conflict_evidence: z
			.array(z.string().regex(/^s[1-9]\d*$/))
			.max(6)
			.describe(
				"Select only excerpt IDs supplied in citations[].excerpts; never write quotes.",
			),
	})
	.strict()
	.refine(
		(value) =>
			(value.resolution === "conflict") === value.conflict_evidence.length > 0,
		"Inconsistent conflict resolution",
	);

export const ConflictReviewOutputSchema = z
	.object({ incompatible: z.boolean() })
	.strict();

export type JudgeAnswerRequirements = {
	granularity: "named_requirement" | "procedure_details" | "unspecified";
	formal_name_required: boolean;
	location_precision?: "designated_destination";
};

export const TablePlanOutputSchema = TableQueryPlanSchema;

export type RouterOutput = z.infer<typeof RouterOutputSchema>;
export type RewriteOutput = z.infer<typeof RewriteOutputSchema>;
export type JudgeOutput = z.infer<typeof JudgeOutputSchema>;
export type ConflictOutput = z.infer<typeof ConflictOutputSchema>;
export type TablePlanOutput = TableQueryPlan;

type StructuredKind =
	| "router"
	| "rewrite"
	| "judge"
	| "refusal_review"
	| "conflict"
	| "conflict_review"
	| "table_plan";

interface StructuredSchemaMap {
	router: typeof RouterOutputSchema;
	rewrite: typeof RewriteOutputSchema;
	judge: typeof JudgeOutputSchema;
	refusal_review: typeof RefusalReviewOutputSchema;
	conflict: typeof ConflictSelectionOutputSchema;
	conflict_review: typeof ConflictReviewOutputSchema;
	table_plan: typeof TablePlanOutputSchema;
}

export interface StructuredGenerationRequest {
	model: LanguageModel;
	instructions: string;
	messages: ModelMessage[];
	schema: z.ZodType;
	schemaName: StructuredKind;
	temperature: number;
	maxOutputTokens?: number;
	abortSignal?: AbortSignal;
	onUsage?: (usage: ModelUsageObservation) => void;
}

export type StructuredGenerationExecutor = (
	request: StructuredGenerationRequest,
) => Promise<unknown>;

export class StructuredOutputValidationError extends Error {
	readonly kind: StructuredKind;
	readonly issues: z.core.$ZodIssue[];

	constructor(kind: StructuredKind, error: z.ZodError) {
		super(`Invalid ${kind} structured output`);
		this.name = "StructuredOutputValidationError";
		this.kind = kind;
		this.issues = error.issues;
	}
}

export class StructuredOutputTimeoutError extends Error {
	readonly kind: StructuredKind;
	readonly timeoutMs: number;

	constructor(kind: StructuredKind, timeoutMs: number) {
		super(`${kind} structured output timed out after ${timeoutMs}ms`);
		this.name = "StructuredOutputTimeoutError";
		this.kind = kind;
		this.timeoutMs = timeoutMs;
	}
}

export type StructuredOutputAdapterOptions = {
	timeoutMs?: number;
	maxAttempts?: number;
	maxOutputTokens?: number;
	concurrencyGate?: AiConcurrencyGateLike;
	usageRecorder?: ModelUsageRecorder;
};

export type StructuredRequestMetadata = {
	attempts: number;
	durationMs: number;
	inputTokens?: number;
	outputTokens?: number;
	totalTokens?: number;
	conflictReview?: { confirmed: boolean; attempts: number; durationMs: number };
};

export type StructuredFailureMetadata = Readonly<{
	kind: StructuredKind;
	completedConflict?: Readonly<{ attempts: number; durationMs: number }>;
	attempts: number;
	durationMs: number;
	timeoutMs: number;
	maxAttempts: number;
	budgetMs: number;
	category:
		| "timeout"
		| "authentication"
		| "rate_limit"
		| "provider_unavailable"
		| "output_truncated"
		| "invalid_output"
		| "provider_error"
		| "unknown";
	statusCode: number | null;
	retryable: boolean;
}>;

// Keep the original error identity for cancellation/auth checks; never attach raw
// provider bodies or prompts to the public diagnostic projection.
const failureMetadata = new WeakMap<object, StructuredFailureMetadata>();

export function getStructuredFailureMetadata(
	error: unknown,
): StructuredFailureMetadata | undefined {
	return error !== null && typeof error === "object"
		? failureMetadata.get(error)
		: undefined;
}

function classifyFailure(
	error: unknown,
): Pick<StructuredFailureMetadata, "category" | "statusCode" | "retryable"> {
	if (error instanceof StructuredOutputTimeoutError) {
		return { category: "timeout", statusCode: null, retryable: true };
	}
	if (
		NoObjectGeneratedError.isInstance(error) &&
		error.finishReason === "length"
	) {
		return { category: "output_truncated", statusCode: null, retryable: true };
	}
	if (
		error instanceof StructuredOutputValidationError ||
		NoObjectGeneratedError.isInstance(error) ||
		NoOutputGeneratedError.isInstance(error)
	) {
		return { category: "invalid_output", statusCode: null, retryable: true };
	}
	const cause = RetryError.isInstance(error) ? error.lastError : error;
	if (APICallError.isInstance(cause)) {
		const statusCode = cause.statusCode ?? null;
		const category =
			statusCode === 401 || statusCode === 403
				? "authentication"
				: statusCode === 429
					? "rate_limit"
					: statusCode !== null && statusCode >= 500
						? "provider_unavailable"
						: "provider_error";
		return {
			category,
			statusCode,
			retryable: category !== "authentication" && cause.isRetryable,
		};
	}
	return { category: "unknown", statusCode: null, retryable: true };
}

class DefaultStructuredResult {
	constructor(
		readonly output: unknown,
		readonly usage: ModelUsageTokens,
	) {}
}

async function defaultStructuredExecutor(
	request: StructuredGenerationRequest,
): Promise<unknown> {
	const result = await generateText({
		model: request.model,
		// The adapter owns retries so each HTTP attempt rechecks authorization
		// and is counted against the configured structured-output budget.
		maxRetries: 0,
		instructions: request.instructions,
		messages: request.messages,
		temperature: request.temperature,
		...(request.maxOutputTokens !== undefined
			? { maxOutputTokens: request.maxOutputTokens }
			: {}),
		abortSignal: request.abortSignal,
		output: Output.object({
			schema: request.schema,
			name: request.schemaName,
		}),
		experimental_telemetry: metadataOnlyAiTelemetry(
			`unorag.structured.${request.schemaName}`,
		),
	});
	const usage = normalizeModelUsage(result.usage);
	request.onUsage?.(usage);
	return new DefaultStructuredResult(result.output, usage);
}

function userMessage(content: string): ModelMessage {
	return { role: "user", content };
}

export class StructuredOutputAdapter {
	private readonly timeoutMs: number;
	private readonly maxAttempts: number;
	private readonly maxOutputTokens: number | undefined;
	private readonly concurrencyGate: AiConcurrencyGateLike | undefined;
	private readonly usageRecorder: ModelUsageRecorder | undefined;

	constructor(
		private readonly model: LanguageModel,
		private readonly execute: StructuredGenerationExecutor = defaultStructuredExecutor,
		options: StructuredOutputAdapterOptions = {},
	) {
		this.timeoutMs = positiveInteger(options.timeoutMs, 15_000, "timeoutMs");
		this.maxAttempts = positiveInteger(options.maxAttempts, 2, "maxAttempts");
		this.maxOutputTokens =
			options.maxOutputTokens === undefined
				? undefined
				: positiveInteger(options.maxOutputTokens, 1, "maxOutputTokens");
		this.concurrencyGate = options.concurrencyGate;
		this.usageRecorder = options.usageRecorder;
	}

	private async request<K extends StructuredKind>(
		kind: K,
		schema: StructuredSchemaMap[K],
		prompt: VersionedPrompt,
		messages: ModelMessage[],
		abortSignal?: AbortSignal,
		beforeRequest?: () => Promise<void>,
		maxAttempts = this.maxAttempts,
	): Promise<{
		output: z.infer<StructuredSchemaMap[K]>;
		metadata: StructuredRequestMetadata;
	}> {
		const startedAt = performance.now();
		let lastError: unknown;
		for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
			if (abortSignal?.aborted) throw abortSignal.reason;
			let lease:
				| Awaited<ReturnType<AiConcurrencyGateLike["acquire"]>>
				| undefined;
			let timeout: NodeJS.Timeout | undefined;
			let requestStarted = false;
			let usageAttempt: ReturnType<typeof startModelUsageAttempt> | undefined;
			let observedUsage: ModelUsageObservation | undefined;
			try {
				// Admission has its own queue bound and timeout. Provider execution gets
				// the full structured-output budget after a permit is granted.
				lease = await this.concurrencyGate?.acquire(abortSignal);
				await beforeRequest?.();
				if (abortSignal?.aborted) throw abortSignal.reason;
				requestStarted = true;
				usageAttempt = startModelUsageAttempt(
					this.model,
					kind === "conflict_review" ? "conflict" : kind,
					attempt,
					this.usageRecorder,
				);
				const timeoutController = new AbortController();
				const operationSignal = abortSignal
					? AbortSignal.any([abortSignal, timeoutController.signal])
					: timeoutController.signal;
				const timeoutError = new StructuredOutputTimeoutError(
					kind,
					this.timeoutMs,
				);
				const raw = await withActiveSpan(
					"unorag.ai.structured",
					{
						"gen_ai.operation.name": "chat",
						"langfuse.observation.type": "chain",
						"langfuse.observation.metadata.capture_content": false,
						...promptSpanAttributes(prompt),
						"unorag.ai.structured_kind": kind,
						"unorag.retry.attempt": attempt,
					},
					() =>
						Promise.race([
							this.execute({
								model: this.model,
								instructions: prompt.text,
								messages,
								schema,
								schemaName: kind,
								temperature: STRUCTURED_TEMPERATURE,
								maxOutputTokens: this.maxOutputTokens,
								abortSignal: operationSignal,
								onUsage: (usage) => {
									observedUsage = normalizeModelUsage(usage);
									usageAttempt?.onUsage(observedUsage);
								},
							}),
							new Promise<never>((_, reject) => {
								timeout = setTimeout(() => {
									timeoutController.abort(timeoutError);
									reject(timeoutError);
								}, this.timeoutMs);
							}),
						]),
				);
				const output =
					raw instanceof DefaultStructuredResult ? raw.output : raw;
				if (abortSignal?.aborted) throw abortSignal.reason;
				if (raw instanceof DefaultStructuredResult) {
					observedUsage = raw.usage;
					usageAttempt.onUsage(raw.usage);
				}
				const parsed = schema.safeParse(output);
				if (!parsed.success) {
					throw new StructuredOutputValidationError(kind, parsed.error);
				}
				usageAttempt.finish("completed");
				const usage = observedUsage;
				return {
					output: parsed.data as z.infer<StructuredSchemaMap[K]>,
					metadata: {
						attempts: attempt,
						durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
						...(usage?.inputTokens != null
							? { inputTokens: usage.inputTokens }
							: {}),
						...(usage?.outputTokens != null
							? { outputTokens: usage.outputTokens }
							: {}),
						...(usage?.totalTokens != null
							? { totalTokens: usage.totalTokens }
							: {}),
					},
				};
			} catch (error) {
				if (!requestStarted) throw error;
				if (NoObjectGeneratedError.isInstance(error) && error.usage) {
					usageAttempt?.onUsage(error.usage);
				}
				usageAttempt?.finish(abortSignal?.aborted ? "cancelled" : "failed");
				if (abortSignal?.aborted) throw error;
				if (
					error instanceof AiConcurrencyOverloadedError ||
					error instanceof AiConcurrencyWaitTimeoutError
				) {
					throw error;
				}
				lastError = error;
				const classification = classifyFailure(error);
				if (error !== null && typeof error === "object") {
					failureMetadata.set(
						error,
						Object.freeze({
							...classification,
							kind,
							attempts: attempt,
							durationMs:
								Math.round((performance.now() - startedAt) * 100) / 100,
							timeoutMs: this.timeoutMs,
							maxAttempts,
							budgetMs: this.timeoutMs * maxAttempts,
						}),
					);
				}
				if (!classification.retryable) break;
			} finally {
				if (timeout) clearTimeout(timeout);
				lease?.release();
			}
		}
		throw lastError;
	}

	route(
		input: {
			question: string;
			history?: Array<{ role: "user" | "assistant"; content: string }>;
		},
		options: {
			abortSignal?: AbortSignal;
			beforeRequest?: () => Promise<void>;
		} = {},
	): Promise<RouterOutput> {
		return this.request(
			"router",
			RouterOutputSchema,
			getPrompt("router"),
			[
				userMessage(
					`问题：${input.question.trim()}\n历史：${JSON.stringify(input.history ?? [])}`,
				),
			],
			options.abortSignal,
			options.beforeRequest,
		).then((result) => result.output);
	}

	rewrite(
		input: {
			question: string;
			history: readonly { role: "user" | "assistant"; content: string }[];
		},
		options: {
			abortSignal?: AbortSignal;
			beforeRequest?: () => Promise<void>;
		} = {},
	): Promise<RewriteOutput> {
		return this.request(
			"rewrite",
			RewriteOutputSchema,
			getPrompt("rewrite"),
			[
				userMessage(
					JSON.stringify({ history: input.history, question: input.question }),
				),
			],
			options.abortSignal,
			options.beforeRequest,
		).then((result) => result.output);
	}

	judge(
		input: {
			question: string;
			citations: unknown[];
			attempts: number;
			requirements?: JudgeAnswerRequirements;
		},
		options: {
			abortSignal?: AbortSignal;
			beforeRequest?: () => Promise<void>;
		} = {},
	): Promise<JudgeOutput> {
		return this.judgeWithMetadata(input, options).then(
			(result) => result.output,
		);
	}

	judgeWithMetadata(
		input: {
			question: string;
			citations: unknown[];
			attempts: number;
			requirements?: JudgeAnswerRequirements;
		},
		options: {
			abortSignal?: AbortSignal;
			beforeRequest?: () => Promise<void>;
		} = {},
	): Promise<{ output: JudgeOutput; metadata: StructuredRequestMetadata }> {
		return this.request(
			"judge",
			JudgeOutputSchema,
			getPrompt("judge"),
			[
				userMessage(
					`服务端回答粒度：${JSON.stringify(input.requirements ?? { granularity: "unspecified", formal_name_required: false })}\n问题：${input.question.trim()}\n尝试次数：${input.attempts}\n候选证据：${JSON.stringify(input.citations)}`,
				),
			],
			options.abortSignal,
			options.beforeRequest,
		);
	}

	reviewRefusalWithMetadata(
		input: {
			question: string;
			citations: unknown[];
			requirements: JudgeAnswerRequirements;
		},
		options: {
			abortSignal?: AbortSignal;
			beforeRequest?: () => Promise<void>;
		} = {},
	) {
		return this.request(
			"refusal_review",
			RefusalReviewOutputSchema,
			getPrompt("refusal_review"),
			[userMessage(JSON.stringify(input))],
			options.abortSignal,
			options.beforeRequest,
			1,
		);
	}

	async checkConflictWithMetadata(
		input: {
			question: string;
			citations: unknown[];
			evidence_ids: string[];
			query_type?: string;
		},
		options: {
			abortSignal?: AbortSignal;
			beforeRequest?: () => Promise<void>;
		} = {},
	): Promise<{ output: ConflictOutput; metadata: StructuredRequestMetadata }> {
		const excerpts = createConflictExcerpts(input.citations);
		const schema = ConflictSelectionOutputSchema.superRefine(
			(value, context) => {
				const seen = new Set<string>();
				for (const id of value.conflict_evidence) {
					if (!excerpts.has(id) || seen.has(id))
						context.addIssue({
							code: "custom",
							message: "Invalid excerpt reference",
						});
					seen.add(id);
				}
			},
		);
		const result = await this.request(
			"conflict",
			schema,
			getPrompt("conflict"),
			[
				userMessage(
					JSON.stringify({ ...input, citations: excerpts.citations }),
				),
			],
			options.abortSignal,
			options.beforeRequest,
		);
		const proposed = result.output.conflict_evidence.map(excerpts.resolve);
		if (!proposed.length)
			return {
				output: { ...result.output, conflict_evidence: proposed },
				metadata: result.metadata,
			};
		validateConflictEvidence(
			proposed,
			excerpts.citations.map((source) => ({
				id: source.id,
				text: source.excerpts.map((item) => item.text).join(" "),
			})),
		);
		const review = await this.reviewConflictWithMetadata(
			{
				question: input.question,
				citations: proposed.map((item, index) => {
					const source = excerpts.citations.find(
						(value) => value.id === item.evidence_id,
					);
					if (!source) throw new Error("Conflict source missing");
					return {
						id: `v${index + 1}`,
						doc_id: source.doc_id,
						title: source.title,
						filename: source.filename,
						document_context: source.document_context,
						section_path: source.section_path,
						preamble: source.preamble,
						text: item.quote,
					};
				}),
			},
			options,
		).catch((error) => {
			const failure = getStructuredFailureMetadata(error);
			if (failure)
				failureMetadata.set(
					error as object,
					Object.freeze({
						...failure,
						completedConflict: Object.freeze({
							attempts: result.metadata.attempts,
							durationMs: result.metadata.durationMs,
						}),
					}),
				);
			throw error;
		});
		const metadata: StructuredRequestMetadata = {
			attempts: result.metadata.attempts + review.metadata.attempts,
			durationMs:
				Math.round(
					(result.metadata.durationMs + review.metadata.durationMs) * 100,
				) / 100,
			conflictReview: {
				confirmed: review.output.incompatible,
				attempts: review.metadata.attempts,
				durationMs: review.metadata.durationMs,
			},
		};
		for (const key of ["inputTokens", "outputTokens", "totalTokens"] as const) {
			const first = result.metadata[key],
				second = review.metadata[key];
			if (first !== undefined && second !== undefined)
				metadata[key] = first + second;
		}
		return {
			output: review.output.incompatible
				? { ...result.output, conflict_evidence: proposed }
				: {
						comparison: "未确认原文明示不一致，不以未知条件推断冲突。",
						resolution: "consistent",
						conflict_evidence: [],
					},
			metadata,
		};
	}

	reviewConflictWithMetadata(
		input: { question: string; citations: unknown[] },
		options: {
			abortSignal?: AbortSignal;
			beforeRequest?: () => Promise<void>;
		} = {},
	) {
		return this.request(
			"conflict_review",
			ConflictReviewOutputSchema,
			getPrompt("conflict_review"),
			[userMessage(JSON.stringify(input))],
			options.abortSignal,
			options.beforeRequest,
			1,
		);
	}

	planTable(
		input: {
			question: string;
			tables?: Array<{ tableId: string; headers: string[] }>;
		},
		options: {
			abortSignal?: AbortSignal;
			beforeRequest?: () => Promise<void>;
		} = {},
	): Promise<TablePlanOutput> {
		return this.request(
			"table_plan",
			TablePlanOutputSchema,
			getPrompt("table_plan"),
			[
				userMessage(
					`问题：${input.question.trim()}\n候选表与真实表头：${JSON.stringify(input.tables ?? [])}`,
				),
			],
			options.abortSignal,
			options.beforeRequest,
		).then((result) => result.output);
	}
}

function positiveInteger(
	value: number | undefined,
	fallback: number,
	name: string,
): number {
	const resolved = value ?? fallback;
	if (!Number.isInteger(resolved) || resolved <= 0) {
		throw new Error(`${name} must be a positive integer`);
	}
	return resolved;
}
