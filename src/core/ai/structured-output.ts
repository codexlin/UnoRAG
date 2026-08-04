import {
	generateText,
	type LanguageModel,
	type LanguageModelUsage,
	type ModelMessage,
	Output,
} from "ai";
import { z } from "zod";
import { metadataOnlyAiTelemetry } from "@/lib/observability/ai-telemetry";
import { withActiveSpan } from "@/lib/observability/tracing";
import { type TableQueryPlan, TableQueryPlanSchema } from "../ask-graph/table";
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
		can_retry: z.boolean().optional(),
		top_score: z.number().min(0).max(1).optional(),
	})
	.strict();

export const TablePlanOutputSchema = TableQueryPlanSchema;

export type RouterOutput = z.infer<typeof RouterOutputSchema>;
export type RewriteOutput = z.infer<typeof RewriteOutputSchema>;
export type JudgeOutput = z.infer<typeof JudgeOutputSchema>;
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
};

export type StructuredRequestMetadata = {
	attempts: number;
	durationMs: number;
	inputTokens?: number;
	outputTokens?: number;
	totalTokens?: number;
};

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
	}

	private async request<K extends StructuredKind>(
		kind: K,
		schema: StructuredSchemaMap[K],
		prompt: VersionedPrompt,
		messages: ModelMessage[],
		abortSignal?: AbortSignal,
	): Promise<{
		output: z.infer<StructuredSchemaMap[K]>;
		metadata: StructuredRequestMetadata;
	}> {
		const startedAt = performance.now();
		let lastError: unknown;
		for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
			if (abortSignal?.aborted) throw abortSignal.reason;
			const timeoutController = new AbortController();
			const operationSignal = abortSignal
				? AbortSignal.any([abortSignal, timeoutController.signal])
				: timeoutController.signal;
			let timeout: NodeJS.Timeout | undefined;
			try {
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
				if (abortSignal?.aborted) throw error;
				lastError = error;
			} finally {
				if (timeout) clearTimeout(timeout);
			}
		}
		throw lastError;
	}

	route(
		input: {
			question: string;
			history?: Array<{ role: "user" | "assistant"; content: string }>;
		},
		options: { abortSignal?: AbortSignal } = {},
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
		).then((result) => result.output);
	}

	rewrite(
		input: {
			question: string;
			fallbackSemanticQuery: string;
		},
		options: { abortSignal?: AbortSignal } = {},
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
		).then((result) => result.output);
	}

	judge(
		input: {
			question: string;
			citations: unknown[];
			attempts: number;
		},
		options: { abortSignal?: AbortSignal } = {},
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
		},
		options: { abortSignal?: AbortSignal } = {},
	): Promise<{ output: JudgeOutput; metadata: StructuredRequestMetadata }> {
		return this.request(
			"judge",
			JudgeOutputSchema,
			getPrompt("judge"),
			[
				userMessage(
					`问题：${input.question.trim()}\n尝试次数：${input.attempts}\n候选证据：${JSON.stringify(input.citations)}`,
				),
			],
			options.abortSignal,
		);
	}

	planTable(
		input: {
			question: string;
			tables?: Array<{ tableId: string; headers: string[] }>;
		},
		options: { abortSignal?: AbortSignal } = {},
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
