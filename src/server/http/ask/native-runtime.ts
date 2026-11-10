import "server-only";

import { randomUUID } from "node:crypto";
import {
	AiConcurrencyOverloadedError,
	AiConcurrencyWaitTimeoutError,
	AnswerStreamAdapter,
	aiConfigFromEnv,
	createAiProviderRegistry,
	getStructuredFailureMetadata,
	judgeAiConfigFromEnv,
	StructuredOutputAdapter,
} from "@/core/ai";
import { assessEvidenceWithMetadata } from "@/core/ai/evidence-assessment";
import {
	type AskGraphContext,
	type AskGraphInput,
	AskGraphService,
	type AskState,
} from "@/core/ask-graph";
import { deriveAnswerRequirements } from "@/core/ask-graph/answer-requirements";
import {
	boundedJudgeEvidenceText,
	compactComparisonEvidence,
} from "@/core/ask-graph/comparison-evidence";
import { conflictAnswer } from "@/core/ask-graph/evidence-conflict";
import { deriveGroundedTableLookup } from "@/core/ask-graph/table";
import {
	isFormFieldLookup,
	isFormTableOperation,
	isProseChecklistLookup,
} from "@/core/ask-graph/table/query-intent";
import type { AuthorizedScope, RetrievalFilters } from "@/core/contracts";
import type {
	DefaultRetrievalService,
	InternalCitation,
	RetrievalResult,
} from "@/core/retrieval";
import { semanticEvidenceScore } from "@/core/retrieval/citation-mapper";
import type { ActiveDocumentDescriptor } from "@/core/retrieval/document-constraints";
import {
	captureAskGenerationStream,
	isEvaluationCaptureEnabled,
	recordAskRetrieval,
	withAskRetrievalCapture,
} from "@/evaluation/sensitive-capture";
import type { AuthIdentity } from "@/lib/server/auth/provider";
import { DrizzleActiveGenerationResolver } from "@/server/retrieval/active-generation-resolver";
import { resolveAuthorizedRetrievalScope } from "@/server/retrieval/authorized-scope";
import { loadActiveDocumentCatalog } from "@/server/retrieval/document-catalog";
import { getTypeScriptRetrievalService } from "@/server/retrieval/runtime";
import { getSharedAiConcurrencyGate } from "./ai-concurrency";
import {
	documentEvidenceFilters,
	resolveAskDocumentEvidence,
} from "./document-evidence";
import type { NativeAskPolicy } from "./policy";
import {
	createTableRuntimePorts,
	deterministicTableAnswer,
	tableCandidates,
} from "./table-runtime";

export {
	deterministicTableAnswer,
	executePlannedTableQuery,
} from "./table-runtime";

type RetrievalService = Pick<DefaultRetrievalService, "retrieve"> &
	Partial<Pick<DefaultRetrievalService, "lookupDocumentRecord">>;

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
	loadDocumentCatalog?: (input: {
		identity: AuthIdentity;
		libraryId: string;
		scope: AuthorizedScope;
	}) => Promise<{ documents: ActiveDocumentDescriptor[]; complete: boolean }>;
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
	if (isFormFieldLookup(normalized)) {
		return {
			queryType: "fact",
			reason: "structured_router_fallback_form_field",
		};
	}
	if (isProseChecklistLookup(normalized)) {
		return {
			queryType: "fact",
			reason: "structured_router_fallback_checklist_prose",
		};
	}
	if (
		FALLBACK_TABLE_PATTERN.test(normalized) ||
		isFormTableOperation(normalized)
	) {
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

export function projectJudgeEvidence(citations: InternalCitation[]) {
	return citations.map((citation) => ({
		id: citation.id,
		record_type: citation.record_type,
		filename: citation.filename,
		doc_id: citation.doc_id,
		title: citation.title,
		page_start: citation.page_start,
		page_end: citation.page_end,
		section_path: citation.section_path,
		preamble: citation.preamble,
		score: citation.score,
		text: boundedJudgeEvidenceText(
			citation.body || citation.text || citation.snippet,
		),
	}));
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
				`[source:${index + 1}] ${citation.title || citation.filename || citation.doc_id}`,
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
	private readonly retrievedEvidence: Record<string, unknown>[] = [];
	private documentConstraintStatus = "none";
	private documentScope: ActiveDocumentDescriptor[] = [];
	private outlineAnswer: { text: string; citationId: string } | null = null;

	constructor(
		private readonly identity: AuthIdentity,
		private readonly libraryId: string,
		private readonly signal: AbortSignal | undefined,
		private readonly policy: NativeAskPolicy,
		private readonly dependencies: NativeAskRuntimeDependencies,
		private readonly assertAuthorized?: (
			citations: Record<string, unknown>[],
		) => Promise<void>,
	) {
		this.graph = new AskGraphService(this.context());
	}

	private async retrieve(
		state: AskState,
		input: { tableOnly: boolean },
	): Promise<RetrievalResult> {
		await this.assertAuthorized?.(this.retrievedEvidence);
		const scope = await resolveAuthorizedRetrievalScope({
			identity: this.identity,
			libraryId: this.libraryId,
			resolver: new DrizzleActiveGenerationResolver(),
		});
		if (!scope) throw new NativeAskRequestError(404, "library not found");
		this.outlineAnswer = null;
		this.documentScope = [];
		this.documentConstraintStatus = "none";
		let retrievalScope = scope;
		const loadDocumentCatalog = this.dependencies.loadDocumentCatalog;
		if (loadDocumentCatalog) {
			const resolution = await resolveAskDocumentEvidence({
				question: state.question ?? "",
				libraryId: this.libraryId,
				scope,
				filters: documentEvidenceFilters(filters(state)),
				signal: this.signal,
				loadCatalog: () =>
					loadDocumentCatalog({
						identity: this.identity,
						libraryId: this.libraryId,
						scope,
					}),
				lookupDocumentRecord: (input) =>
					this.dependencies.retrieval.lookupDocumentRecord?.(input) ??
					Promise.resolve(null),
			});
			this.documentConstraintStatus = resolution.status;
			this.documentScope = resolution.documents;
			retrievalScope = resolution.scope;
			if (
				["unavailable", "ambiguous", "outline_unavailable"].includes(
					resolution.status,
				)
			)
				return this.emptyDocumentResult(scope);
			if (resolution.outline) {
				this.outlineAnswer = {
					text: resolution.outline.text,
					citationId: resolution.outline.citation.id,
				};
				this.retrievedEvidence.push(resolution.outline.citation);
				return {
					...this.emptyDocumentResult(scope),
					citations: [resolution.outline.citation],
				};
			}
		}
		const result = await this.dependencies.retrieval.retrieve({
			query: query(state),
			libraryId: this.libraryId,
			scope: retrievalScope,
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
				preserveFigureLineage:
					!input.tableOnly && state.query_type !== "compare",
				lineageMinScore: this.evidenceThreshold(),
			},
			signal: this.signal,
		});
		this.retrievedEvidence.push(...result.citations);
		if (
			!input.tableOnly &&
			isEvaluationCaptureEnabled(state.session_id ?? "")
		) {
			recordAskRetrieval({
				requestId: state.trace_id ?? "",
				sessionId: state.session_id ?? "",
				question: state.question ?? "",
				query: query(state),
				attempt: (state.retrieval_attempts ?? 0) + 1,
				citations: result.citations.map(({ body }) => ({ body })),
			});
		}
		return {
			...result,
			debug: {
				...result.debug,
				documentConstraintStatus: this.documentConstraintStatus,
			},
		};
	}

	private emptyDocumentResult(scope: AuthorizedScope): RetrievalResult {
		return {
			citations: [],
			debug: {
				usedHybrid: false,
				hybridEnabled: false,
				hybridFailed: false,
				hybridError: null,
				usedRerank: false,
				rerankFailed: false,
				retrievalMode: "dense",
				denseHitCount: 0,
				activeGenerationCount: scope.activeGenerationIds.length,
				documentConstraintStatus: this.documentConstraintStatus,
			},
		};
	}

	getEvidenceReferences(): Record<string, unknown>[] {
		return this.retrievedEvidence;
	}

	private beforeModelRequest = async () => {
		await this.assertAuthorized?.(this.retrievedEvidence);
	};

	private evidenceThreshold(): number {
		return this.policy.citation_adjudicate_enabled
			? Math.max(
					this.policy.answer_min_score,
					this.policy.citation_adjudicate_absolute_floor,
				)
			: this.policy.answer_min_score;
	}

	private adjudicate(result: RetrievalResult): RetrievalResult {
		const threshold = this.evidenceThreshold();
		const citations = result.citations.filter(
			(citation) =>
				citation.id === this.outlineAnswer?.citationId ||
				semanticEvidenceScore(citation) >= threshold,
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
					await this.assertAuthorized?.(this.retrievedEvidence);
					try {
						const rewritten = await structured.rewrite(
							{ question, fallbackSemanticQuery: question },
							{
								abortSignal: this.signal,
								beforeRequest: this.beforeModelRequest,
							},
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
					if (
						["unavailable", "ambiguous", "outline_unavailable"].includes(
							this.documentConstraintStatus,
						)
					) {
						return {
							sufficient: false,
							action: "refuse",
							reason: "document_scope_unavailable",
							can_retry: false,
							evidence_ids: [],
							judge_mode: "deterministic_document_scope",
						};
					}
					if (
						this.outlineAnswer &&
						citations.some(
							(citation) => citation.id === this.outlineAnswer?.citationId,
						)
					) {
						await this.assertAuthorized?.(this.retrievedEvidence);
						return {
							sufficient: true,
							action: "generate",
							reason: "complete_parser_outline",
							evidence_ids: [this.outlineAnswer.citationId],
							judge_mode: "deterministic_document_outline",
						};
					}
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
					await this.assertAuthorized?.(this.retrievedEvidence);
					try {
						const requirements = deriveAnswerRequirements(state.question ?? "");
						const judged = await assessEvidenceWithMetadata(
							judgeStructured,
							{
								question: state.question ?? "",
								query_type: state.query_type,
								requirements,
								citations: [
									...projectJudgeEvidence(citations).map((citation) => ({
										...citation,
										document_identity: this.documentScope.find(
											(doc) => doc.documentId === citation.doc_id,
										)?.context?.identifiers,
									})),
									...(state.table_execution
										? [{ table_execution: state.table_execution }]
										: []),
								],
								attempts: state.retrieval_attempts ?? 0,
							},
							{
								abortSignal: this.signal,
								beforeRequest: this.beforeModelRequest,
							},
						);
						return {
							...judged.output,
							answer_granularity: requirements.granularity,
							reason:
								judged.output.reason === "judge_unavailable"
									? judged.output.action === "generate"
										? "evidence_sufficient"
										: "insufficient_evidence"
									: judged.output.reason,
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
						const failure = getStructuredFailureMetadata(error);
						return {
							sufficient: false,
							action: "refuse",
							reason: "judge_unavailable",
							can_retry: false,
							judge_mode: "model_error",
							judge_model: judgeIdentity.modelId,
							judge_provider: judgeIdentity.providerName,
							...(failure
								? {
										judge_attempts: failure.attempts,
										judge_failed_stage: failure.kind,
										judge_duration_ms: failure.durationMs,
										judge_timeout_ms: failure.timeoutMs,
										judge_max_attempts: failure.maxAttempts,
										judge_budget_ms: failure.budgetMs,
										judge_error_category: failure.category,
										judge_status_code: failure.statusCode,
										judge_retryable: failure.retryable,
									}
								: {}),
						};
					}
				},
			},
			ports: {
				retrieve: async (state) => {
					let result = this.adjudicate(
						await this.retrieve(state, { tableOnly: false }),
					);
					let groundedPlan = deriveGroundedTableLookup(
						state.question ?? "",
						tableCandidates(result.citations),
					);
					let tableProbe = false;
					// Normal recall returns text projections without rows. Resolve their
					// table identity through the same authorized retrieval boundary.
					if (
						!groundedPlan &&
						result.citations.some((citation) => citation.table_id)
					) {
						tableProbe = true;
						const precise = this.adjudicate(
							await this.retrieve(state, { tableOnly: true }),
						);
						groundedPlan = deriveGroundedTableLookup(
							state.question ?? "",
							tableCandidates(precise.citations),
						);
						if (groundedPlan) result = precise;
					}
					return {
						citations:
							!groundedPlan && state.query_type === "compare"
								? compactComparisonEvidence(result.citations)
								: result.citations,
						...(groundedPlan
							? { upgrade: "precise", upgrade_reason: "grounded_table_lookup" }
							: {}),
						retrieval_attempts: (state.retrieval_attempts ?? 0) + 1,
						retrieval_debug: {
							...(state.retrieval_debug ?? {}),
							...result.debug,
							rerankDiagnostic: result.debug.rerankDiagnostic ?? null,
							grounded_lookup_probe: tableProbe,
						},
					};
				},
				tableRetrieve: async (state) => {
					if (state.upgrade_reason === "grounded_table_lookup") {
						return {
							citations: state.citations ?? [],
							retrieval_debug: {
								...(state.retrieval_debug ?? {}),
								table_candidate_count: state.citations?.length ?? 0,
								rerankDiagnostic: null,
							},
						};
					}
					const result = await this.retrieve(state, { tableOnly: true });
					return {
						citations: result.citations,
						retrieval_attempts: (state.retrieval_attempts ?? 0) + 1,
						retrieval_debug: {
							...(state.retrieval_debug ?? {}),
							...result.debug,
							rerankDiagnostic: result.debug.rerankDiagnostic ?? null,
							table_candidate_count: result.citations.length,
						},
					};
				},
				...createTableRuntimePorts({
					structured,
					signal: this.signal,
					assertAuthorized: this.beforeModelRequest,
				}),
				generate: () => ({
					answer: "",
					refused: false,
					refuse_reason: null,
				}),
			},
		};
	}

	invoke(input: AskGraphInput): Promise<AskState> {
		return withAskRetrievalCapture(() =>
			this.graph.invoke({
				...input,
				library_id: this.libraryId,
				trace_id: input.trace_id || randomUUID(),
			}),
		);
	}

	async *streamAnswer(state: AskState): AsyncGenerator<string> {
		await this.beforeModelRequest();
		const conflict = conflictAnswer(state);
		if (conflict) {
			yield conflict;
			return;
		}
		const deterministicAnswer =
			this.outlineAnswer &&
			state.citations?.some(
				(citation) => citation.id === this.outlineAnswer?.citationId,
			)
				? this.outlineAnswer.text
				: deterministicTableAnswer(state.table_execution);
		if (deterministicAnswer) {
			yield deterministicAnswer;
			return;
		}
		const generationInput = {
			question: state.question ?? "",
			requirements: deriveAnswerRequirements(state.question ?? ""),
			context: [
				...this.documentScope
					.filter((doc) =>
						state.citations?.some(
							(citation) => citation.doc_id === doc.documentId,
						),
					)
					.map(
						(doc) =>
							`已定位的文档：${doc.context?.title || doc.filename}；文件编号：${doc.context?.identifiers.join("、") || "未提供"}`,
					),
				contextText(state),
			].join("\n\n"),
			history: (state.history ?? []).flatMap<{
				role: "user" | "assistant";
				content: string;
			}>((item) => {
				const role = item.role;
				const content = item.content;
				return (role === "user" || role === "assistant") &&
					typeof content === "string"
					? [{ role, content }]
					: [];
			}),
		};
		yield* captureAskGenerationStream(
			{
				requestId: state.trace_id ?? "",
				sessionId: state.session_id ?? "",
				...generationInput,
			},
			this.dependencies.answer.stream(generationInput, {
				allowedCitationIndices: (state.citations ?? []).map(
					(_, index) => index + 1,
				),
				abortSignal: this.signal,
				beforeRequest: this.beforeModelRequest,
			}),
		);
	}
}

export function createNativeAskRuntime(input: {
	identity: AuthIdentity;
	libraryId: string;
	signal?: AbortSignal;
	policy: NativeAskPolicy;
	dependencies?: NativeAskRuntimeDependencies;
	assertAuthorized?: (citations: Record<string, unknown>[]) => Promise<void>;
}): NativeAskRuntime {
	let dependencies = input.dependencies;
	if (!dependencies) {
		const registry = createAiProviderRegistry(aiConfigFromEnv());
		const judgeRegistry = createAiProviderRegistry(judgeAiConfigFromEnv());
		const concurrencyGate = getSharedAiConcurrencyGate();
		dependencies = {
			retrieval: getTypeScriptRetrievalService(),
			loadDocumentCatalog: loadActiveDocumentCatalog,
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
		input.assertAuthorized,
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
