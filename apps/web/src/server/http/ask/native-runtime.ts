import "server-only";

import { randomUUID } from "node:crypto";
import {
	AnswerStreamAdapter,
	aiConfigFromEnv,
	createAiProviderRegistry,
	StructuredOutputAdapter,
} from "@/core/ai";
import {
	type AskGraphContext,
	type AskGraphInput,
	AskGraphService,
	type AskState,
} from "@/core/ask-graph";
import {
	executeTableQuery,
	type TableDatasetInput,
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

import type { NativeAskPolicy } from "./policy";

type RetrievalService = Pick<DefaultRetrievalService, "retrieve">;

export type NativeAskRuntimeDependencies = {
	retrieval: RetrievalService;
	structured: StructuredOutputAdapter;
	answer: AnswerStreamAdapter;
};

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
		.map(
			(citation, index) =>
				`[${index + 1}] ${citation.title || citation.filename || citation.doc_id}\n${citation.body || citation.text || citation.snippet}`,
		)
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
		if (!scope) throw new Error("library is outside the authorized scope");
		return this.dependencies.retrieval.retrieve({
			query: query(state),
			libraryId: this.libraryId,
			scope,
			topK: input.tableOnly
				? Math.max(30, this.policy.retrieve_top_k)
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
		return {
			queryRouter: {
				route: async ({ question, history }) => {
					const routed = await structured.route(
						{
							question,
							history: history.flatMap((item) => {
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
					return {
						queryType: routed.query_type,
						reason: routed.reason,
					};
				},
			},
			queryRewriter: {
				rewrite: async ({ question }) => {
					const rewritten = await structured.rewrite(
						{ question, fallbackSemanticQuery: question },
						{ abortSignal: this.signal },
					);
					return {
						query: rewritten.semantic_query,
						mode: "structured",
						plan: { filters: rewritten.filters },
					};
				},
			},
			judge: {
				judge: (state) =>
					structured.judge(
						{
							question: state.question ?? "",
							citations: [
								...(state.citations ?? []),
								...(state.table_execution
									? [{ table_execution: state.table_execution }]
									: []),
							],
							attempts: state.retrieval_attempts ?? 0,
						},
						{ abortSignal: this.signal },
					),
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
					const plan = await structured.planTable(
						{
							question: state.question ?? "",
							tables: candidates.map(({ tableId, headers }) => ({
								tableId,
								headers,
							})),
						},
						{ abortSignal: this.signal },
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
		dependencies = {
			retrieval: getTypeScriptRetrievalService(),
			structured: new StructuredOutputAdapter(registry.model),
			answer: new AnswerStreamAdapter(registry.model),
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
