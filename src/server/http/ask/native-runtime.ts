import "server-only";

import { randomUUID } from "node:crypto";
import {
	AiConcurrencyOverloadedError,
	AiConcurrencyWaitTimeoutError,
	AnswerStreamAdapter,
	aiConfigFromEnv,
	createAiProviderRegistry,
	judgeAiConfigFromEnv,
	StructuredOutputAdapter,
} from "@/core/ai";
import {
	type AskGraphContext,
	type AskGraphInput,
	AskGraphService,
	type AskState,
} from "@/core/ask-graph";
import {
	deriveDeterministicTablePlan,
	executeTableQuery,
	normalizeTablePlanForQuestion,
	type TableDatasetInput,
	TableExecutionResultSchema,
	type TableQueryPlan,
	TableQueryPlanSchema,
} from "@/core/ask-graph/table";
import type { RetrievalFilters } from "@/core/contracts";
import type {
	DefaultRetrievalService,
	InternalCitation,
	RetrievalResult,
} from "@/core/retrieval";
import type { AuthIdentity } from "@/lib/server/auth/provider";
import { DrizzleActiveGenerationResolver } from "@/server/retrieval/active-generation-resolver";
import { resolveAuthorizedRetrievalScope } from "@/server/retrieval/authorized-scope";
import { getTypeScriptRetrievalService } from "@/server/retrieval/runtime";
import { getSharedAiConcurrencyGate } from "./ai-concurrency";
import type { NativeAskPolicy } from "./policy";

type RetrievalService = Pick<DefaultRetrievalService, "retrieve">;

const FALLBACK_TABLE_PATTERN =
	/(?:表格|表中|表内|明细表|清单|台账|逐行|多少行|表头|列名|字段|序号\s*(?:为|是)?\s*\d+|rows?|row\s*#?\s*\d+)/i;
const FALLBACK_FOLLOW_UP_PATTERN =
	/^(?:那|那么|这个|它|上述|前者|后者|还有|为什么|具体呢|分别呢)/i;

export type NativeAskRuntimeDependencies = {
	retrieval: RetrievalService;
	structured: StructuredOutputAdapter;
	judgeStructured?: StructuredOutputAdapter;
	judgeIdentity?: { modelId: string; providerName: string };
	answer: AnswerStreamAdapter;
};

export class NativeAskRequestError extends Error {
	constructor(
		readonly status: 404,
		message: string,
	) {
		super(message);
		this.name = "NativeAskRequestError";
	}
}

export function fallbackQueryRoute(
	question: string,
	historyCount = 0,
): { queryType: string; reason: string } {
	const normalized = question.trim();
	if (FALLBACK_TABLE_PATTERN.test(normalized)) {
		return { queryType: "table", reason: "structured_router_fallback_table" };
	}
	if (historyCount > 0 && FALLBACK_FOLLOW_UP_PATTERN.test(normalized)) {
		return {
			queryType: "follow_up",
			reason: "structured_router_fallback_follow_up",
		};
	}
	if (Array.from(normalized).length >= 4) {
		return { queryType: "fact", reason: "structured_router_fallback_fact" };
	}
	return {
		queryType: "ambiguous",
		reason: "structured_router_fallback_ambiguous",
	};
}

function throwIfAborted(signal: AbortSignal | undefined, error: unknown): void {
	if (signal?.aborted) throw error;
}

function throwIfConcurrencyUnavailable(error: unknown): void {
	if (
		error instanceof AiConcurrencyOverloadedError ||
		error instanceof AiConcurrencyWaitTimeoutError
	) {
		throw error;
	}
}

function boundedEvidenceText(value: unknown, maxLength = 2_400): string {
	const text = typeof value === "string" ? value.trim() : "";
	return text.length <= maxLength ? text : `${text.slice(0, maxLength)}…`;
}

export function projectJudgeEvidence(citations: InternalCitation[]) {
	return citations.map((citation) => ({
		id: citation.id,
		record_type: citation.record_type,
		filename: citation.filename,
		title: citation.title,
		page_start: citation.page_start,
		page_end: citation.page_end,
		section_path: citation.section_path,
		preamble: citation.preamble,
		score: citation.score,
		text: boundedEvidenceText(
			citation.body || citation.text || citation.snippet,
		),
	}));
}

export function deterministicTableAnswer(value: unknown): string | null {
	const parsed = TableExecutionResultSchema.safeParse(value);
	if (parsed.success && parsed.data.status === "success") {
		const answer = parsed.data.answerText?.trim();
		return answer || null;
	}
	return null;
}

function query(state: AskState): string {
	return state.rewritten_question?.trim() || state.question?.trim() || "";
}

function filters(state: AskState): RetrievalFilters | undefined {
	const value = state.retrieval_plan?.filters;
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as RetrievalFilters)
		: undefined;
}

function tableCandidates(citations: InternalCitation[]) {
	const grouped = new Map<string, InternalCitation[]>();
	for (const citation of citations) {
		if (citation.record_type !== "table" || !citation.table_id) continue;
		const key = `${citation.doc_id}:${citation.document_version_id}:${citation.table_id}`;
		const current = grouped.get(key) ?? [];
		current.push(citation);
		grouped.set(key, current);
	}
	return [...grouped.entries()].map(([tableId, records]) => ({
		tableId: records[0]?.table_id ?? tableId,
		headers: [...new Set(records.flatMap((record) => record.headers))],
		dataset: { records } satisfies TableDatasetInput,
	}));
}

function selectTableCandidate(
	candidates: ReturnType<typeof tableCandidates>,
	tableId: string,
) {
	const matches = candidates.filter(
		(candidate) => candidate.tableId === tableId,
	);
	return matches.length === 1 ? matches[0] : null;
}

export function executePlannedTableQuery(
	plan: TableQueryPlan,
	citations: InternalCitation[],
) {
	const candidates = tableCandidates(citations);
	if (plan.mode === "single") {
		const candidate = selectTableCandidate(candidates, plan.tableId);
		return candidate ? executeTableQuery(plan, candidate.dataset) : null;
	}
	const left = selectTableCandidate(candidates, plan.leftTableId);
	const right = selectTableCandidate(candidates, plan.rightTableId);
	return left && right
		? executeTableQuery(plan, {
				left: left.dataset,
				right: right.dataset,
			})
		: null;
}

function selectEvidenceCitations(
	citations: InternalCitation[],
	evidenceIds: string[],
): InternalCitation[] {
	const selected = new Set(evidenceIds);
	return citations.filter((citation) => selected.has(citation.id));
}

function contextText(state: AskState): string {
	const citations = (state.citations ?? []) as InternalCitation[];
	const evidence = citations
		.map((citation, index) => {
			const body = citation.body || citation.text || citation.snippet;
			const location = [
				citation.heading_text,
				citation.section_path,
				citation.preamble,
			]
				.map((value) => value?.trim())
				.filter(
					(value, position, values): value is string =>
						typeof value === "string" &&
						value.length > 0 &&
						values.indexOf(value) === position &&
						!body.includes(value),
				)
				.join(" / ");
			return [
				`[${index + 1}] ${citation.title || citation.filename || citation.doc_id}`,
				location,
				body,
			]
				.filter(Boolean)
				.join("\n");
		})
		.join("\n\n");
	const table =
		state.table_execution && Object.keys(state.table_execution).length
			? `\n\n确定性表格执行结果：\n${JSON.stringify(state.table_execution)}`
			: "";
	return `${evidence}${table}`.trim();
}

export class NativeAskRuntime {
	private readonly graph: AskGraphService;

	constructor(
		private readonly identity: AuthIdentity,
		private readonly libraryId: string,
		private readonly signal: AbortSignal | undefined,
		private readonly policy: NativeAskPolicy,
		private readonly dependencies: NativeAskRuntimeDependencies,
	) {
		this.graph = new AskGraphService(this.context());
	}

	private async retrieve(
		state: AskState,
		input: { tableOnly: boolean },
	): Promise<RetrievalResult> {
		const scope = await resolveAuthorizedRetrievalScope({
			identity: this.identity,
			libraryId: this.libraryId,
			resolver: new DrizzleActiveGenerationResolver(),
		});
		if (!scope) throw new NativeAskRequestError(404, "library not found");
		return this.dependencies.retrieval.retrieve({
			query: query(state),
			libraryId: this.libraryId,
			scope,
			topK: input.tableOnly
				? Math.max(30, this.policy.retrieve_top_k)
				: state.query_type === "compare"
					? Math.max(20, this.policy.retrieve_top_k)
					: state.query_type === "summary"
						? Math.max(10, this.policy.retrieve_top_k)
						: this.policy.retrieve_top_k,
			filters: input.tableOnly
				? { ...filters(state), record_type: "table" }
				: filters(state),
			options: {
				hybridEnabled: this.policy.hybrid_enabled,
				rerankEnabled: this.policy.rerank_enabled,
			},
			signal: this.signal,
		});
	}

	private adjudicate(result: RetrievalResult): RetrievalResult {
		const threshold = this.policy.citation_adjudicate_enabled
			? Math.max(
					this.policy.answer_min_score,
					this.policy.citation_adjudicate_absolute_floor,
				)
			: this.policy.answer_min_score;
		const citations = result.citations.filter(
			(citation) => citation.score >= threshold,
		);
		return {
			...result,
			citations,
			debug: {
				...result.debug,
				candidateCountBeforePolicy: result.citations.length,
				evidenceThreshold: threshold,
			},
		};
	}

	private context(): AskGraphContext {
		const structured = this.dependencies.structured;
		const judgeStructured = this.dependencies.judgeStructured ?? structured;
		const judgeIdentity = this.dependencies.judgeIdentity ?? {
			modelId: "shared",
			providerName: "injected",
		};
		return {
			queryRouter: {
				route: ({ question, history }) =>
					fallbackQueryRoute(question, history.length),
			},
			queryRewriter: {
				rewrite: async ({ question, history }) => {
					if (history.length === 0) {
						return { query: question, mode: "identity_first_turn" };
					}
					try {
						const rewritten = await structured.rewrite(
							{ question, fallbackSemanticQuery: question },
							{ abortSignal: this.signal },
						);
						return {
							query: rewritten.semantic_query,
							mode: "structured",
							plan: { filters: rewritten.filters },
						};
					} catch (error) {
						throwIfAborted(this.signal, error);
						throwIfConcurrencyUnavailable(error);
						return { query: question, mode: "structured_fallback" };
					}
				},
			},
			judge: {
				judge: async (state) => {
					const citations = (state.citations ?? []) as InternalCitation[];
					if (citations.length === 0 && !state.table_execution) {
						const canRetry = (state.retrieval_attempts ?? 0) < 2;
						return {
							sufficient: false,
							action: canRetry ? "retry" : "refuse",
							reason: "no_evidence",
							can_retry: canRetry,
							judge_mode: "deterministic_no_evidence",
							judge_model: null,
							judge_provider: null,
						};
					}
					try {
						const judged = await judgeStructured.judgeWithMetadata(
							{
								question: state.question ?? "",
								citations: [
									...projectJudgeEvidence(citations),
									...(state.table_execution
										? [{ table_execution: state.table_execution }]
										: []),
								],
								attempts: state.retrieval_attempts ?? 0,
							},
							{ abortSignal: this.signal },
						);
						return {
							...judged.output,
							judge_mode: "model",
							judge_model: judgeIdentity.modelId,
							judge_provider: judgeIdentity.providerName,
							judge_attempts: judged.metadata.attempts,
							judge_duration_ms: judged.metadata.durationMs,
							...(judged.metadata.inputTokens !== undefined
								? { judge_input_tokens: judged.metadata.inputTokens }
								: {}),
							...(judged.metadata.outputTokens !== undefined
								? { judge_output_tokens: judged.metadata.outputTokens }
								: {}),
							...(judged.metadata.totalTokens !== undefined
								? { judge_total_tokens: judged.metadata.totalTokens }
								: {}),
						};
					} catch (error) {
						throwIfAborted(this.signal, error);
						throwIfConcurrencyUnavailable(error);
						return {
							sufficient: false,
							action: "refuse",
							reason: "judge_unavailable",
							can_retry: false,
							judge_mode: "model_error",
							judge_model: judgeIdentity.modelId,
							judge_provider: judgeIdentity.providerName,
						};
					}
				},
			},
			ports: {
				retrieve: async (state) => {
					const result = this.adjudicate(
						await this.retrieve(state, { tableOnly: false }),
					);
					return {
						citations: result.citations,
						retrieval_attempts: (state.retrieval_attempts ?? 0) + 1,
						retrieval_debug: {
							...(state.retrieval_debug ?? {}),
							...result.debug,
						},
					};
				},
				tableRetrieve: async (state) => {
					const result = await this.retrieve(state, { tableOnly: true });
					return {
						citations: result.citations,
						retrieval_attempts: (state.retrieval_attempts ?? 0) + 1,
						retrieval_debug: {
							...(state.retrieval_debug ?? {}),
							...result.debug,
							table_candidate_count: result.citations.length,
						},
					};
				},
				buildTablePlan: async (state) => {
					const candidates = tableCandidates(
						(state.citations ?? []) as InternalCitation[],
					);
					if (!candidates.length) {
						return {
							table_query_plan: { invalid: true },
							refuse_reason: "table_incomplete",
						};
					}
					const candidateHeaders = candidates.map(({ tableId, headers }) => ({
						tableId,
						headers,
					}));
					const deterministicPlan = deriveDeterministicTablePlan(
						state.question ?? "",
						candidateHeaders,
					);
					if (deterministicPlan) {
						return { table_query_plan: deterministicPlan };
					}
					const generatedPlan = await structured.planTable(
						{
							question: state.question ?? "",
							tables: candidateHeaders,
						},
						{ abortSignal: this.signal },
					);
					const plan = normalizeTablePlanForQuestion(
						state.question ?? "",
						generatedPlan,
						candidates,
					);
					return { table_query_plan: plan };
				},
				tableExecute: (state) => {
					const citations = (state.citations ?? []) as InternalCitation[];
					const parsed = TableQueryPlanSchema.safeParse(state.table_query_plan);
					if (!parsed.success) {
						return {
							answer: "没有足够的表格结构信息来可靠执行该问题。",
							citations: [],
							refused: true,
							refuse_reason: "table_incomplete",
							judgement: {
								sufficient: false,
								action: "refuse",
								reason: "table_incomplete",
							},
						};
					}
					const plan: TableQueryPlan = parsed.data;
					const execution = executePlannedTableQuery(plan, citations);
					if (!execution) {
						return {
							answer: "无法唯一确定要执行的表格。",
							citations: [],
							refused: true,
							refuse_reason: "table_incomplete",
							judgement: {
								sufficient: false,
								action: "refuse",
								reason: "table_id_unavailable",
							},
						};
					}
					if (execution.status !== "success") {
						const clarify = execution.status === "clarify";
						return {
							answer: clarify
								? "请明确要查询的表格列或比较对象。"
								: "无法根据现有表格结构可靠执行该问题。",
							citations: [],
							table_execution: execution,
							refused: true,
							refuse_reason: "table_incomplete",
							judgement: {
								sufficient: false,
								action: clarify ? "clarify" : "refuse",
								reason: "table_incomplete",
							},
						};
					}
					return {
						table_execution: execution,
						retrieval_debug: {
							...(state.retrieval_debug ?? {}),
							judge_mode: "deterministic_table_execution",
							judge_model: null,
							judge_provider: null,
						},
						citations: selectEvidenceCitations(
							citations,
							execution.evidence.map((item) => item.citationId),
						),
					};
				},
				generate: () => ({
					answer: "",
					refused: false,
					refuse_reason: null,
				}),
			},
		};
	}

	invoke(input: AskGraphInput): Promise<AskState> {
		return this.graph.invoke({
			...input,
			library_id: this.libraryId,
			trace_id: input.trace_id || randomUUID(),
		});
	}

	streamAnswer(state: AskState) {
		const deterministicAnswer = deterministicTableAnswer(state.table_execution);
		if (deterministicAnswer) {
			return (async function* () {
				yield deterministicAnswer;
			})();
		}
		return this.dependencies.answer.stream(
			{
				question: state.question ?? "",
				context: contextText(state),
				history: (state.history ?? []).flatMap((item) => {
					const role = item.role;
					const content = item.content;
					return (role === "user" || role === "assistant") &&
						typeof content === "string"
						? [{ role, content }]
						: [];
				}),
			},
			{ abortSignal: this.signal },
		);
	}
}

export function createNativeAskRuntime(input: {
	identity: AuthIdentity;
	libraryId: string;
	signal?: AbortSignal;
	policy: NativeAskPolicy;
	dependencies?: NativeAskRuntimeDependencies;
}): NativeAskRuntime {
	let dependencies = input.dependencies;
	if (!dependencies) {
		const registry = createAiProviderRegistry(aiConfigFromEnv());
		const judgeRegistry = createAiProviderRegistry(judgeAiConfigFromEnv());
		const concurrencyGate = getSharedAiConcurrencyGate();
		dependencies = {
			retrieval: getTypeScriptRetrievalService(),
			structured: new StructuredOutputAdapter(registry.model, undefined, {
				timeoutMs: positiveEnvironmentInteger(
					"ASK_STRUCTURED_TIMEOUT_MS",
					15_000,
				),
				maxAttempts: positiveEnvironmentInteger(
					"ASK_STRUCTURED_MAX_ATTEMPTS",
					2,
				),
				concurrencyGate,
			}),
			judgeStructured: new StructuredOutputAdapter(
				judgeRegistry.model,
				undefined,
				{
					timeoutMs: positiveEnvironmentInteger("ASK_JUDGE_TIMEOUT_MS", 15_000),
					maxAttempts: positiveEnvironmentInteger("ASK_JUDGE_MAX_ATTEMPTS", 2),
					maxOutputTokens: positiveEnvironmentInteger(
						"ASK_JUDGE_MAX_OUTPUT_TOKENS",
						1024,
					),
					concurrencyGate,
				},
			),
			judgeIdentity: {
				modelId: judgeRegistry.modelId,
				providerName: judgeRegistry.providerName,
			},
			answer: new AnswerStreamAdapter(registry.model, undefined, {
				concurrencyGate,
			}),
		};
	}
	return new NativeAskRuntime(
		input.identity,
		input.libraryId,
		input.signal,
		input.policy,
		dependencies,
	);
}

function positiveEnvironmentInteger(name: string, fallback: number): number {
	const raw = process.env[name]?.trim();
	if (!raw) return fallback;
	const value = Number(raw);
	if (!Number.isInteger(value) || value <= 0) {
		throw new Error(`${name} must be a positive integer`);
	}
	return value;
}
