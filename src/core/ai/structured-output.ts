import {
	APICallError,
	generateText,
	type LanguageModel,
	type LanguageModelUsage,
	type ModelMessage,
	NoObjectGeneratedError,
	NoOutputGeneratedError,
	Output,
	RetryError,
} from "ai";
import { z } from "zod";
import { metadataOnlyAiTelemetry } from "@/lib/observability/ai-telemetry";
import { withActiveSpan } from "@/lib/observability/tracing";
import { ConflictEvidenceSchema } from "../ask-graph/evidence-conflict";
import { type TableQueryPlan, TableQueryPlanSchema } from "../ask-graph/table";
import {
	type AiConcurrencyGateLike,
	AiConcurrencyOverloadedError,
	AiConcurrencyWaitTimeoutError,
} from "./concurrency-gate";
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

const RetrievalRecordTypeSchema = z.enum([
	"chunk",
	"section",
	"document",
	"table",
	"table_summary",
	"figure",
	"chunk+table_summary",
	"text",
]);

export const RewriteOutputSchema = z
	.object({
		semantic_query: z.string().trim().min(1),
		filters: z
			.object({
				record_type: RetrievalRecordTypeSchema.optional(),
				doc_id: z.string().trim().min(1).optional(),
				table_id: z.string().trim().min(1).optional(),
				document_version_id: z.string().trim().min(1).optional(),
			})
			.strict()
			.default({}),
	})
	.strict();

export const JudgeOutputSchema = z
	.object({
		sufficient: z.boolean(),
		action: z.enum(["generate", "retry", "refuse"]),
		reason: z.string().trim().min(1),
		evidence_ids: z.array(z.string().trim().min(1)).max(6),
		evidence_assessment: z.union([
			z
				.object({
					resolution: z.enum(["consistent", "scoped", "precedence"]),
					conflict_evidence: ConflictEvidenceSchema.length(0),
				})
				.strict(),
			z
				.object({
					resolution: z.literal("conflict"),
					conflict_evidence: ConflictEvidenceSchema.min(1),
				})
				.strict(),
		]),
		can_retry: z.boolean().optional(),
		top_score: z.number().min(0).max(1).optional(),
	})
	.strict()
	.superRefine((value, context) => {
		const assessment = value.evidence_assessment;
		const conflict = assessment.resolution === "conflict";
		if (
			conflict &&
			(!value.sufficient ||
				value.action !== "generate" ||
				assessment.conflict_evidence.some(
					(item) => !value.evidence_ids.includes(item.evidence_id),
				))
		) {
			context.addIssue({
				code: "custom",
				message: "Inconsistent evidence resolution",
			});
		}
	});

export type JudgeAnswerRequirements = {
	granularity: "named_requirement" | "procedure_details" | "unspecified";
	formal_name_required: boolean;
};

export const TablePlanOutputSchema = TableQueryPlanSchema;

export type RouterOutput = z.infer<typeof RouterOutputSchema>;
export type RewriteOutput = z.infer<typeof RewriteOutputSchema>;
type JudgeModelOutput = z.infer<typeof JudgeOutputSchema>;
export type JudgeOutput = Omit<JudgeModelOutput, "evidence_assessment"> & {
	evidence_resolution: JudgeModelOutput["evidence_assessment"]["resolution"];
	conflict_evidence: JudgeModelOutput["evidence_assessment"]["conflict_evidence"];
};
export type TablePlanOutput = TableQueryPlan;

type StructuredKind = "router" | "rewrite" | "judge" | "table_plan";

interface StructuredSchemaMap {
	router: typeof RouterOutputSchema;
	rewrite: typeof RewriteOutputSchema;
	judge: typeof JudgeOutputSchema;
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
};

export type StructuredRequestMetadata = {
	attempts: number;
	durationMs: number;
	inputTokens?: number;
	outputTokens?: number;
	totalTokens?: number;
};

export type StructuredFailureMetadata = Readonly<{
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
		| "provider_error";
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
	return { category: "provider_error", statusCode: null, retryable: true };
}

class DefaultStructuredResult {
	constructor(
		readonly output: unknown,
		readonly usage: LanguageModelUsage,
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
	return new DefaultStructuredResult(result.output, result.usage);
}

function userMessage(content: string): ModelMessage {
	return { role: "user", content };
}

export class StructuredOutputAdapter {
	private readonly timeoutMs: number;
	private readonly maxAttempts: number;
	private readonly maxOutputTokens: number | undefined;
	private readonly concurrencyGate: AiConcurrencyGateLike | undefined;

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
	}

	private async request<K extends StructuredKind>(
		kind: K,
		schema: StructuredSchemaMap[K],
		prompt: VersionedPrompt,
		messages: ModelMessage[],
		abortSignal?: AbortSignal,
		beforeRequest?: () => Promise<void>,
	): Promise<{
		output: z.infer<StructuredSchemaMap[K]>;
		metadata: StructuredRequestMetadata;
	}> {
		const startedAt = performance.now();
		let lastError: unknown;
		for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
			if (abortSignal?.aborted) throw abortSignal.reason;
			let lease:
				| Awaited<ReturnType<AiConcurrencyGateLike["acquire"]>>
				| undefined;
			let timeout: NodeJS.Timeout | undefined;
			let requestStarted = false;
			try {
				// Admission has its own queue bound and timeout. Provider execution gets
				// the full structured-output budget after a permit is granted.
				lease = await this.concurrencyGate?.acquire(abortSignal);
				await beforeRequest?.();
				if (abortSignal?.aborted) throw abortSignal.reason;
				requestStarted = true;
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
				const parsed = schema.safeParse(output);
				if (!parsed.success) {
					throw new StructuredOutputValidationError(kind, parsed.error);
				}
				const usage =
					raw instanceof DefaultStructuredResult ? raw.usage : undefined;
				return {
					output: parsed.data as z.infer<StructuredSchemaMap[K]>,
					metadata: {
						attempts: attempt,
						durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
						...(usage?.inputTokens !== undefined
							? { inputTokens: usage.inputTokens }
							: {}),
						...(usage?.outputTokens !== undefined
							? { outputTokens: usage.outputTokens }
							: {}),
						...(usage?.totalTokens !== undefined
							? { totalTokens: usage.totalTokens }
							: {}),
					},
				};
			} catch (error) {
				if (!requestStarted) throw error;
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
							attempts: attempt,
							durationMs:
								Math.round((performance.now() - startedAt) * 100) / 100,
							timeoutMs: this.timeoutMs,
							maxAttempts: this.maxAttempts,
							budgetMs: this.timeoutMs * this.maxAttempts,
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
			fallbackSemanticQuery: string;
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
					`原问题：${input.question.trim()}\n已有改写（可参考）：${input.fallbackSemanticQuery.trim()}`,
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
		).then(({ output, metadata }) => {
			const { evidence_assessment, ...judgement } = output;
			return {
				metadata,
				output: {
					...judgement,
					evidence_resolution: evidence_assessment.resolution,
					conflict_evidence: evidence_assessment.conflict_evidence,
				},
			};
		});
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
