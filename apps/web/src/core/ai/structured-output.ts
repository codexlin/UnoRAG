import {
	generateText,
	type LanguageModel,
	type ModelMessage,
	Output,
} from "ai";
import { z } from "zod";
import { type TableQueryPlan, TableQueryPlanSchema } from "../ask-graph/table";

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
	"chunk+table_summary",
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
		action: z.enum(["generate", "retry", "refuse", "clarify"]),
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
	messages: ModelMessage[];
	schema: z.ZodType;
	schemaName: StructuredKind;
	temperature: number;
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

const ROUTER_SYSTEM_PROMPT =
	"你是 UnoRAG 查询路由器。仅输出结构化结果。分类只能是 fact、follow_up、summary、compare、table、section_lookup、ambiguous；不执行检索，不生成答案。";

const REWRITE_SYSTEM_PROMPT =
	"你是检索计划助手。semantic_query 可对原问做检索友好改写；无把握则原样。filters 只允许 record_type、doc_id、table_id、document_version_id。不要编造标识，不要输出 tenant_id、workspace_id、library_id、generation 或 ACL 字段。";

const JUDGE_SYSTEM_PROMPT =
	"你是证据充分性判断器。仅根据给定候选证据判断 generate、retry、refuse 或 clarify。资料未覆盖时必须 refuse，不能用模型常识补足。";

const TABLE_PLAN_SYSTEM_PROMPT =
	"你是表格执行计划器。只根据问题和真实表头制定严格计划；列名必须逐字来自所给表头。" +
	"单表使用 mode=single，双表显式给出 join 键；无法确定列名、连接键或运算时不要猜测，由调用方拒答或澄清。";

async function defaultStructuredExecutor(
	request: StructuredGenerationRequest,
): Promise<unknown> {
	const result = await generateText({
		model: request.model,
		messages: request.messages,
		temperature: request.temperature,
		abortSignal: request.abortSignal,
		output: Output.object({
			schema: request.schema,
			name: request.schemaName,
		}),
	});
	return result.output;
}

function userMessage(content: string): ModelMessage {
	return { role: "user", content };
}

function systemMessage(content: string): ModelMessage {
	return { role: "system", content };
}

export class StructuredOutputAdapter {
	constructor(
		private readonly model: LanguageModel,
		private readonly execute: StructuredGenerationExecutor = defaultStructuredExecutor,
	) {}

	private async request<K extends StructuredKind>(
		kind: K,
		schema: StructuredSchemaMap[K],
		messages: ModelMessage[],
		abortSignal?: AbortSignal,
	): Promise<z.infer<StructuredSchemaMap[K]>> {
		const raw = await this.execute({
			model: this.model,
			messages,
			schema,
			schemaName: kind,
			temperature: STRUCTURED_TEMPERATURE,
			abortSignal,
		});
		const parsed = schema.safeParse(raw);
		if (!parsed.success) {
			throw new StructuredOutputValidationError(kind, parsed.error);
		}
		return parsed.data as z.infer<StructuredSchemaMap[K]>;
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
			[
				systemMessage(ROUTER_SYSTEM_PROMPT),
				userMessage(
					`问题：${input.question.trim()}\n历史：${JSON.stringify(input.history ?? [])}`,
				),
			],
			options.abortSignal,
		);
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
			[
				systemMessage(REWRITE_SYSTEM_PROMPT),
				userMessage(
					`原问题：${input.question.trim()}\n已有改写（可参考）：${input.fallbackSemanticQuery.trim()}`,
				),
			],
			options.abortSignal,
		);
	}

	judge(
		input: {
			question: string;
			citations: unknown[];
			attempts: number;
		},
		options: { abortSignal?: AbortSignal } = {},
	): Promise<JudgeOutput> {
		return this.request(
			"judge",
			JudgeOutputSchema,
			[
				systemMessage(JUDGE_SYSTEM_PROMPT),
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
			[
				systemMessage(TABLE_PLAN_SYSTEM_PROMPT),
				userMessage(
					`问题：${input.question.trim()}\n候选表与真实表头：${JSON.stringify(input.tables ?? [])}`,
				),
			],
			options.abortSignal,
		);
	}
}
