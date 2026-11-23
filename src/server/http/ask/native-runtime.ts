import "server-only";

import { randomUUID } from "node:crypto";
import {
	AiConcurrencyOverloadedError,
	AiConcurrencyWaitTimeoutError,
	AnswerStreamAdapter,
	aiConfigFromEnv,
	createAiProviderRegistry,
	FigureReaderAdapter,
	type FigureReaderPort,
	FigureReaderTimeoutError,
	judgeAiConfigFromEnv,
	StructuredOutputAdapter,
	vlmAiConfigFromEnv,
} from "@/core/ai";
import { assessEvidenceWithMetadata } from "@/core/ai/evidence-assessment";
import type { ModelUsageRecorder } from "@/core/ai/model-usage";
import {
	type AskGraphContext,
	type AskGraphInput,
	AskGraphService,
	type AskState,
} from "@/core/ask-graph";
import { deriveAnswerRequirements } from "@/core/ask-graph/answer-requirements";
import {
	clarificationSelection,
	latestClarification,
} from "@/core/ask-graph/clarification";
import {
	boundedJudgeEvidenceText,
	compactComparisonEvidence,
	scopedProbabilityOverlapReason,
} from "@/core/ask-graph/comparison-evidence";
import {
	buildComparisonSubQueries,
	buildMultiAspectSubQueries,
	mergeComparisonCitations,
} from "@/core/ask-graph/comparison-query";
import { conflictAnswer } from "@/core/ask-graph/evidence-conflict";
import { hasFollowupReference } from "@/core/ask-graph/nodes/rewrite";
import { planForGroundedQuestion } from "@/core/ask-graph/nodes/routing";
import { groundedQuestion } from "@/core/ask-graph/state";
import { deriveGroundedTableLookup } from "@/core/ask-graph/table";
import { isEligibleForGroundedTableLookup } from "@/core/ask-graph/table/planning";
import {
	isDerivedCalculationQuestion,
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
import {
	formatCitationEvidenceText,
	semanticEvidenceScore,
} from "@/core/retrieval/citation-mapper";
import type {
	ActiveDocumentCatalog,
	ActiveDocumentDescriptor,
} from "@/core/retrieval/document-constraints";
import type { RetrievalInspection } from "@/core/retrieval/retrieval-service";
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
	evidenceDocumentContext,
	resolveAskDocumentEvidence,
} from "./document-evidence";
import {
	type LoadAuthorizedFigureAssetPort,
	loadAuthorizedFigureAsset,
} from "./figure-assets";
import { rewriteFollowup } from "./followup-rewrite";
import { judgeFailureDebug } from "./judge-diagnostics";
import { askRetrievalOptions, type NativeAskPolicy } from "./policy";
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
const FIGURE_REFERENCE_PATTERN =
	/(?:图表|柱状图|折线图|饼图|雷达图|散点图|示意图|流程图|架构图|走势图|趋势图|分布图|对比图|图示|附图|图\s*\d+|figure\s*\d+|chart|diagram|graph|plot|fig\.\s*\d+)/i;

function figureObservationKey(
	citation: Pick<InternalCitation, "doc_id" | "generation_id" | "figure_id">,
): string | null {
	if (!citation.figure_id || !citation.doc_id || !citation.generation_id) {
		return null;
	}
	return `${citation.doc_id}::${citation.generation_id}::${citation.figure_id}`;
}

export type NativeAskRuntimeDependencies = {
	retrieval: RetrievalService;
	structured: StructuredOutputAdapter;
	judgeStructured?: StructuredOutputAdapter;
	judgeIdentity?: { modelId: string; providerName: string };
	answer: AnswerStreamAdapter;
	figureReader?: FigureReaderPort | null;
	loadFigureAsset?: LoadAuthorizedFigureAssetPort;
	loadDocumentCatalog?: (input: {
		identity: AuthIdentity;
		libraryId: string;
		scope: AuthorizedScope;
		question?: string;
	}) => Promise<ActiveDocumentCatalog>;
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
		!isDerivedCalculationQuestion(normalized) &&
		(FALLBACK_TABLE_PATTERN.test(normalized) ||
			isFormTableOperation(normalized))
	) {
		return { queryType: "table", reason: "structured_router_fallback_table" };
	}
	if (
		historyCount > 0 &&
		(FALLBACK_FOLLOW_UP_PATTERN.test(normalized) ||
			hasFollowupReference(normalized))
	) {
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

export function projectJudgeEvidence(
	citations: InternalCitation[],
	documents: ActiveDocumentDescriptor[] = [],
	figureObservations?: ReadonlyMap<string, string>,
) {
	return citations.map((citation) => {
		const observationKey = figureObservationKey(citation);
		const vlmObservation = observationKey
			? figureObservations?.get(observationKey)
			: undefined;
		return {
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
			document_context: evidenceDocumentContext(citation, documents),
			text: boundedJudgeEvidenceText(formatCitationEvidenceText(citation)),
			...(vlmObservation ? { vlm_observation: vlmObservation } : {}),
		};
	});
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

function contextText(
	state: AskState,
	documents: ActiveDocumentDescriptor[],
	figureObservations?: ReadonlyMap<string, string>,
): string {
	const citations = (state.citations ?? []) as InternalCitation[];
	const evidence = citations
		.map((citation, index) => {
			const body = formatCitationEvidenceText(citation);
			const observationKey = figureObservationKey(citation);
			const observation = observationKey
				? figureObservations?.get(observationKey)
				: undefined;
			const identity = evidenceDocumentContext(citation, documents);
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
				identity
					? `文档身份（仅用于来源归属，不代替正文事实）：${JSON.stringify(identity)}`
					: "文档身份未确认；本项目等指代仅属于当前文档，不能与其他文档默认合并。",
				location,
				body,
				observation
					? `视觉图表核验读数（来自授权裁切图实时识别）：\n${observation}`
					: "",
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
	// Keep previews out of graph state, stage diagnostics, and evaluation captures.
	private readonly retrievalInspections: {
		inspection: RetrievalInspection;
		references: NonNullable<RetrievalResult["inspectionReferences"]>;
	}[] = [];
	private documentConstraintStatus = "none";
	private documentScope: ActiveDocumentDescriptor[] = [];
	private evidenceDocuments: ActiveDocumentDescriptor[] = [];
	private outlineAnswer: { text: string; citationId: string } | null = null;
	private readonly figureObservations = new Map<string, string>();
	private readonly attemptedFigureKeys = new Set<string>();
	private vlmFiguresReadCount = 0;
	private vlmDegradedReason: string | null = null;
	private validatedAnswerCitations = false;

	constructor(
		private readonly identity: AuthIdentity,
		private readonly libraryId: string,
		private readonly signal: AbortSignal | undefined,
		private readonly policy: NativeAskPolicy,
		private readonly dependencies: NativeAskRuntimeDependencies,
		private readonly assertAuthorized?: (
			citations: Record<string, unknown>[],
		) => Promise<void>,
		private readonly includeTraceDetails = false,
	) {
		this.graph = new AskGraphService(this.context());
	}

	private async retrieve(
		state: AskState,
		input: { tableOnly: boolean; applyEvidenceThreshold: boolean },
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
		this.evidenceDocuments = [];
		this.documentConstraintStatus = "none";
		let retrievalScope = scope;
		const loadDocumentCatalog = this.dependencies.loadDocumentCatalog;
		let catalog: ActiveDocumentCatalog | undefined;
		if (loadDocumentCatalog) {
			const resolution = await resolveAskDocumentEvidence({
				question: groundedQuestion(state),
				libraryId: this.libraryId,
				scope,
				filters: documentEvidenceFilters(filters(state)),
				signal: this.signal,
				loadCatalog: async () => {
					catalog = await loadDocumentCatalog({
						identity: this.identity,
						libraryId: this.libraryId,
						scope,
						question: groundedQuestion(state),
					});
					return catalog;
				},
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
		const mainQuery = query(state);
		const isRetryAttempt = (state.retrieval_attempts ?? 0) >= 1;
		const isMultiAspectFact =
			!input.tableOnly &&
			state.query_type === "fact" &&
			/(?:对比|比较|差异|以及|并且|有哪些|分别|应对|措施|战略|合作伙伴)/u.test(
				mainQuery,
			);
		const baseTopK = input.tableOnly
			? Math.max(30, this.policy.retrieve_top_k)
			: state.query_type === "compare"
				? Math.max(20, this.policy.retrieve_top_k)
				: state.query_type === "summary" || isMultiAspectFact
					? Math.max(10, this.policy.retrieve_top_k)
					: this.policy.retrieve_top_k;
		const targetTopK = isRetryAttempt ? Math.max(12, baseTopK) : baseTopK;
		const effectiveFilters: RetrievalFilters | undefined = input.tableOnly
			? { ...filters(state), record_type: "table" }
			: filters(state);
		const retrieveOptions = {
			...askRetrievalOptions(this.policy, isRetryAttempt),
			minimumEvidenceScore: input.applyEvidenceThreshold
				? this.evidenceThreshold()
				: undefined,
			preserveFigureLineage: !input.tableOnly && state.query_type !== "compare",
			lineageMinScore: this.evidenceThreshold(),
			...(this.includeTraceDetails
				? {
						includeTraceDetails: true,
						evidenceThreshold: input.applyEvidenceThreshold
							? this.evidenceThreshold()
							: undefined,
					}
				: {}),
		};
		const comparisonSubQueries =
			!input.tableOnly && state.query_type === "compare"
				? buildComparisonSubQueries(mainQuery)
				: !input.tableOnly && state.query_type === "fact" && isMultiAspectFact
					? buildMultiAspectSubQueries(mainQuery)
					: [];
		const subTopK =
			comparisonSubQueries.length > 0
				? state.query_type === "compare"
					? Math.max(8, Math.ceil(targetTopK / comparisonSubQueries.length))
					: 6
				: 0;
		const [primaryResult, ...subResults] = await Promise.all([
			this.dependencies.retrieval.retrieve({
				query: mainQuery,
				libraryId: this.libraryId,
				scope: retrievalScope,
				topK: targetTopK,
				filters: effectiveFilters,
				options: retrieveOptions,
				signal: this.signal,
			}),
			...comparisonSubQueries.map((subQuery) =>
				this.dependencies.retrieval.retrieve({
					query: subQuery,
					libraryId: this.libraryId,
					scope: retrievalScope,
					topK: subTopK,
					filters: effectiveFilters,
					options: retrieveOptions,
					signal: this.signal,
				}),
			),
		]);
		const result =
			subResults.length > 0
				? {
						...primaryResult,
						citations: mergeComparisonCitations(
							primaryResult.citations,
							subResults.map((item) => item.citations),
							targetTopK,
						),
					}
				: primaryResult;
		if (loadDocumentCatalog && result.citations.length) {
			const allowedGenerations = new Set(retrievalScope.activeGenerationIds);
			const allowedDocuments = retrievalScope.documentIds
				? new Set(retrievalScope.documentIds)
				: null;
			const documentIds = [
				...new Set(
					result.citations
						.filter(
							(citation) =>
								citation.generation_id &&
								allowedGenerations.has(citation.generation_id) &&
								(!allowedDocuments || allowedDocuments.has(citation.doc_id)),
						)
						.map((citation) => citation.doc_id),
				),
			];
			if (documentIds.length) {
				if (!catalog?.complete)
					catalog = await loadDocumentCatalog({
						identity: this.identity,
						libraryId: this.libraryId,
						scope: { ...retrievalScope, documentIds },
					});
				if (!catalog.complete) {
					this.documentConstraintStatus = "unavailable";
					return this.emptyDocumentResult(scope);
				}
				this.evidenceDocuments = catalog.documents;
			}
		}
		this.retrievedEvidence.push(...result.citations);
		if (this.includeTraceDetails) {
			for (const { debug, inspectionReferences } of [
				primaryResult,
				...subResults,
			]) {
				if (debug.inspection && inspectionReferences) {
					this.retrievalInspections.push({
						inspection: debug.inspection,
						references: inspectionReferences,
					});
				}
			}
		}
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
		const { inspection: _inspection, ...debug } = result.debug;
		return {
			citations: result.citations,
			debug: {
				...debug,
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

	getRetrievalInspections() {
		return this.retrievalInspections;
	}

	didValidateAnswerCitations(): boolean {
		return this.validatedAnswerCitations;
	}

	private beforeModelRequest = async () => {
		await this.assertAuthorized?.(this.retrievedEvidence);
	};

	private async enrichFiguresOnDemand(
		question: string,
		citations: InternalCitation[],
	): Promise<number> {
		const candidates = citations.filter((citation) => {
			if (citation.record_type !== "figure") return false;
			const key = figureObservationKey(citation);
			return Boolean(key && !this.attemptedFigureKeys.has(key));
		});
		if (candidates.length === 0) return 0;

		const reader = this.dependencies.figureReader;
		if (!reader) {
			this.vlmDegradedReason ??= "vlm_disabled";
			return 0;
		}
		const maxFigures = reader.maxFiguresPerRequest ?? 2;
		if (this.vlmFiguresReadCount >= maxFigures) {
			this.vlmDegradedReason ??= "vlm_budget_exhausted";
			return 0;
		}

		const loadAsset =
			this.dependencies.loadFigureAsset ?? loadAuthorizedFigureAsset;
		const maxBytes = reader.maxImageBytes ?? 5 * 1024 * 1024;
		let newlyRead = 0;
		for (const citation of candidates) {
			if (this.vlmFiguresReadCount >= maxFigures) {
				this.vlmDegradedReason ??= "vlm_budget_exhausted";
				break;
			}
			const key = figureObservationKey(citation);
			if (
				!key ||
				this.attemptedFigureKeys.has(key) ||
				!citation.figure_id ||
				!citation.generation_id
			) {
				continue;
			}
			this.attemptedFigureKeys.add(key);

			const loaded = await loadAsset({
				identity: this.identity,
				docId: citation.doc_id,
				generationId: citation.generation_id,
				figureId: citation.figure_id,
				maxBytes,
				signal: this.signal,
			});
			if (loaded.status !== "ok") {
				this.vlmDegradedReason ??= loaded.status;
				continue;
			}

			try {
				const result = await reader.readFigure(
					{
						question,
						figureId: citation.figure_id,
						title: citation.title || citation.filename || citation.doc_id,
						pageStart: citation.page_start,
						captionText: formatCitationEvidenceText(citation),
						imageBytes: loaded.bytes,
						mimeType: loaded.mimeType,
					},
					{
						abortSignal: this.signal,
						beforeRequest: this.beforeModelRequest,
					},
				);
				this.figureObservations.set(key, result.observation);
				this.vlmFiguresReadCount += 1;
				newlyRead += 1;
			} catch (error) {
				throwIfAborted(this.signal, error);
				throwIfConcurrencyUnavailable(error);
				this.vlmDegradedReason ??=
					error instanceof FigureReaderTimeoutError
						? "vlm_timeout"
						: "vlm_error";
			}
		}
		return newlyRead;
	}

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
				route: ({ question, history }) => {
					const pending = latestClarification(history);
					return pending && clarificationSelection(question, pending)
						? { queryType: "follow_up", reason: "pending_clarification_reply" }
						: fallbackQueryRoute(question, history.length);
				},
			},
			queryRewriter: {
				rewrite: async ({ question, history }) => {
					const rewritten = await rewriteFollowup(question, history, (input) =>
						structured.rewrite(input, {
							abortSignal: this.signal,
							beforeRequest: this.beforeModelRequest,
						}),
					);
					if (
						rewritten.mode !== "clarification_resolved" &&
						rewritten.mode !== "history_resolved"
					)
						return rewritten;
					// Route the restored task, not the short choice (e.g. "B").
					const route = fallbackQueryRoute(rewritten.query);
					const plan = planForGroundedQuestion(
						route.queryType,
						rewritten.query,
						route.reason,
					);
					if (plan.query_type === "fact") return rewritten;
					return {
						...rewritten,
						plan: {
							...plan,
							...rewritten.plan,
						},
					};
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
					const [document] = this.documentScope;
					const scopedDocument =
						this.documentConstraintStatus === "resolved" &&
						this.documentScope.length === 1 &&
						document &&
						!state.table_execution &&
						citations.every(
							(citation) =>
								citation.doc_id === document.documentId &&
								citation.generation_id === document.generationId,
						)
							? document
							: undefined;
					const question = groundedQuestion(state);
					const overlap =
						scopedDocument && state.query_type === "compare"
							? scopedProbabilityOverlapReason(question, citations)
							: null;
					if (overlap) {
						return {
							sufficient: false,
							action: "refuse",
							reason: overlap,
							can_retry: false,
							evidence_ids: [],
							judge_mode: "deterministic_probability_overlap",
						};
					}
					try {
						const requirements = deriveAnswerRequirements(question);
						const hasUnreadFigureCandidate = () =>
							citations.some((citation) => {
								if (citation.record_type !== "figure") return false;
								const key = figureObservationKey(citation);
								return Boolean(key && !this.attemptedFigureKeys.has(key));
							});
						if (
							FIGURE_REFERENCE_PATTERN.test(question) &&
							hasUnreadFigureCandidate()
						) {
							await this.enrichFiguresOnDemand(question, citations);
						}

						const runJudge = () =>
							assessEvidenceWithMetadata(
								judgeStructured,
								{
									question,
									query_type: state.query_type,
									requirements,
									resolvedDocumentId: scopedDocument?.documentId,
									citations: [
										...projectJudgeEvidence(
											citations,
											this.evidenceDocuments,
											this.figureObservations,
										).map((citation) => ({
											...citation,
											document_identity: citation.document_context?.identifiers,
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
									selectiveConflictCheck:
										process.env.ASK_CONFLICT_CHECK_MODE?.trim().toLowerCase() ===
										"selective",
								},
							);

						let judged = await runJudge();
						if (
							judged.output.action !== "generate" &&
							hasUnreadFigureCandidate()
						) {
							const newlyRead = await this.enrichFiguresOnDemand(
								question,
								citations,
							);
							if (newlyRead > 0) {
								judged = await runJudge();
							}
						}
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
							...(this.vlmFiguresReadCount > 0
								? { vlm_figures_read: this.vlmFiguresReadCount }
								: {}),
							...(this.vlmDegradedReason
								? { vlm_degraded_reason: this.vlmDegradedReason }
								: {}),
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
							...judgeFailureDebug(error),
						};
					}
				},
			},
			ports: {
				retrieve: async (state) => {
					let result = this.adjudicate(
						await this.retrieve(state, {
							tableOnly: false,
							applyEvidenceThreshold: true,
						}),
					);
					let groundedPlan = deriveGroundedTableLookup(
						groundedQuestion(state),
						tableCandidates(result.citations),
					);
					let tableProbe = false;
					// Normal recall returns text projections without rows. Resolve their
					// table identity through the same authorized retrieval boundary.
					if (
						!groundedPlan &&
						isEligibleForGroundedTableLookup(groundedQuestion(state)) &&
						result.citations.some((citation) => citation.table_id)
					) {
						tableProbe = true;
						const primaryContext = {
							documentConstraintStatus: this.documentConstraintStatus,
							documentScope: this.documentScope,
							evidenceDocuments: this.evidenceDocuments,
							outlineAnswer: this.outlineAnswer,
						};
						const precise = this.adjudicate(
							await this.retrieve(state, {
								tableOnly: true,
								applyEvidenceThreshold: true,
							}),
						);
						groundedPlan = deriveGroundedTableLookup(
							groundedQuestion(state),
							tableCandidates(precise.citations),
						);
						if (groundedPlan) result = precise;
						else Object.assign(this, primaryContext);
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
					const result = await this.retrieve(state, {
						tableOnly: true,
						applyEvidenceThreshold: false,
					});
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
				: deterministicTableAnswer(state.table_execution, state.citations);
		if (deterministicAnswer) {
			yield deterministicAnswer;
			return;
		}
		const generationInput = {
			question: groundedQuestion(state),
			requirements: deriveAnswerRequirements(groundedQuestion(state)),
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
				contextText(state, this.evidenceDocuments, this.figureObservations),
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
		this.validatedAnswerCitations = true;
	}
}

export function createNativeAskRuntime(input: {
	identity: AuthIdentity;
	libraryId: string;
	signal?: AbortSignal;
	policy: NativeAskPolicy;
	dependencies?: NativeAskRuntimeDependencies;
	usageRecorder?: ModelUsageRecorder;
	assertAuthorized?: (citations: Record<string, unknown>[]) => Promise<void>;
	includeTraceDetails?: boolean;
}): NativeAskRuntime {
	let dependencies = input.dependencies;
	if (!dependencies) {
		const registry = createAiProviderRegistry(aiConfigFromEnv());
		const judgeRegistry = createAiProviderRegistry(judgeAiConfigFromEnv());
		const vlmConfig = vlmAiConfigFromEnv();
		const vlmRegistry = vlmConfig ? createAiProviderRegistry(vlmConfig) : null;
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
				usageRecorder: input.usageRecorder,
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
					usageRecorder: input.usageRecorder,
				},
			),
			judgeIdentity: {
				modelId: judgeRegistry.modelId,
				providerName: judgeRegistry.providerName,
			},
			answer: new AnswerStreamAdapter(registry.model, undefined, {
				concurrencyGate,
				usageRecorder: input.usageRecorder,
			}),
			figureReader:
				vlmConfig && vlmRegistry
					? new FigureReaderAdapter(vlmRegistry.model, undefined, {
							timeoutMs: vlmConfig.timeoutMs,
							maxFiguresPerRequest: vlmConfig.maxFiguresPerRequest,
							maxImageBytes: vlmConfig.maxImageBytes,
							concurrencyGate,
							usageRecorder: input.usageRecorder,
						})
					: null,
			loadFigureAsset: loadAuthorizedFigureAsset,
		};
	}
	return new NativeAskRuntime(
		input.identity,
		input.libraryId,
		input.signal,
		input.policy,
		dependencies,
		input.assertAuthorized,
		input.includeTraceDetails,
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
