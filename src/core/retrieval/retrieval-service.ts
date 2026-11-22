import type { AuthorizedScope, RetrievalFilters } from "../contracts";
import {
	mapQdrantHitToInternalCitation,
	semanticEvidenceScore,
} from "./citation-mapper";
import {
	type InternalCitation,
	type RetrievalScope,
	RetrievalScopeSchema,
	type RetrievalUserFilters,
	RetrievalUserFiltersSchema,
} from "./contracts";
import type { EmbeddingProvider } from "./embedding/provider";
import { sharesEvidenceLineage } from "./evidence-lineage";
import {
	projectRerankDiagnostic,
	type RerankDiagnostic,
	type RetrievalProviderDiagnostic,
	RetrievalProviderError,
} from "./provider-request";
import type { QdrantSearchHit, StoredQdrantPayload } from "./qdrant/payload";
import type { RetrievalVectorStore } from "./qdrant/store";
import { normalizeRerankResults, type RerankProvider } from "./rerank/provider";
import {
	buildScopedRetrievalCacheKey,
	type ScopedRetrievalCache,
} from "./retrieval-cache";

type CandidateCounts = {
	total: number;
	byRecordType: Record<StoredQdrantPayload["record_type"], number>;
};

export type RetrievalDebug = {
	usedHybrid: boolean;
	hybridEnabled: boolean;
	hybridFailed: boolean;
	hybridError: string | null;
	usedRerank: boolean;
	rerankFailed: boolean;
	retrievalMode: "dense" | "hybrid";
	denseHitCount: number;
	activeGenerationCount: number;
	candidateCountBeforePolicy?: number;
	evidenceThreshold?: number;
	rerankDiagnostic?: RerankDiagnostic;
	documentConstraintStatus?: string;
};

export type RetrievalResult = {
	citations: InternalCitation[];
	debug: RetrievalDebug;
};

export type RetrievalServiceOptions = {
	hybridEnabled: boolean;
	rerankEnabled: boolean;
	rerankTopK: number;
	bm25TopK: number;
	rrfK: number;
	cache?: ScopedRetrievalCache;
};

function toRetrievalScope(
	scope: AuthorizedScope,
	libraryId: string,
): RetrievalScope {
	if (!scope.libraryIds.includes(libraryId)) {
		throw new Error("requested library is outside the authorized scope");
	}
	return RetrievalScopeSchema.parse({
		tenantId: scope.organizationId,
		workspaceId: scope.workspaceId,
		libraryId,
		...(scope.documentIds ? { documentIds: scope.documentIds } : {}),
		principalIds: scope.principalIds,
		groupIds: scope.groupIds,
		activeGenerationIds: scope.activeGenerationIds,
	});
}

export class RetrievalSecurityViolationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RetrievalSecurityViolationError";
	}
}

function intersects(left: string[], right: string[]): boolean {
	const allowed = new Set(left);
	return right.some((value) => allowed.has(value));
}

function assertAuthorizedHits(
	hits: QdrantSearchHit[],
	scope: RetrievalScope,
): QdrantSearchHit[] {
	for (const hit of hits) {
		const payload = hit.payload;
		const generationAllowed =
			typeof payload.generation_id === "string" &&
			scope.activeGenerationIds.includes(payload.generation_id);
		const documentAllowed =
			scope.documentIds === undefined ||
			scope.documentIds.includes(payload.doc_id);
		const aclAllowed =
			payload.acl_scope === "workspace" ||
			(payload.acl_scope === "restricted" &&
				(intersects(scope.principalIds, payload.acl_principal_ids ?? []) ||
					intersects(scope.groupIds, payload.acl_group_ids ?? [])));
		if (
			payload.tenant_id !== scope.tenantId ||
			payload.workspace_id !== scope.workspaceId ||
			payload.library_id !== scope.libraryId ||
			!generationAllowed ||
			!documentAllowed ||
			(payload.lifecycle_visibility != null &&
				payload.lifecycle_visibility !== "active") ||
			!aclAllowed
		) {
			throw new RetrievalSecurityViolationError(
				"vector store returned a hit outside the authorized scope",
			);
		}
	}
	return hits;
}

function toUserFilters(filters?: RetrievalFilters): RetrievalUserFilters {
	return RetrievalUserFiltersSchema.parse(
		Object.fromEntries(
			Object.entries(filters ?? {}).filter(([, value]) => value != null),
		),
	);
}

function hitText(hit: QdrantSearchHit): string {
	const body = hit.payload.body || hit.payload.text;
	const heading = hit.payload.heading_text?.trim();
	return heading && !body.includes(heading) ? `${heading}\n${body}` : body;
}

function deduplicateOverlappingHits(
	hits: QdrantSearchHit[],
): QdrantSearchHit[] {
	const selected: QdrantSearchHit[] = [];
	for (const hit of hits) {
		const body = hitText(hit).replace(/\s+/g, " ").trim();
		const duplicateIndex = selected.findIndex((candidate) => {
			if (candidate.payload.doc_id !== hit.payload.doc_id) return false;
			const candidateBody = hitText(candidate).replace(/\s+/g, " ").trim();
			return (
				Math.min(body.length, candidateBody.length) >= 100 &&
				(body.includes(candidateBody) || candidateBody.includes(body))
			);
		});
		if (duplicateIndex < 0) {
			selected.push(hit);
			continue;
		}
		const duplicate = selected[duplicateIndex];
		if (
			duplicate &&
			recordSpecificity(hit.payload.record_type) >
				recordSpecificity(duplicate.payload.record_type)
		) {
			selected[duplicateIndex] = hit;
		}
	}
	return selected;
}

function recordSpecificity(
	recordType: QdrantSearchHit["payload"]["record_type"],
): number {
	if (recordType === "figure" || recordType === "table") return 3;
	if (recordType === "chunk" || recordType === "table_summary") return 2;
	if (recordType === "section") return 1;
	return 0;
}

function retainFigureCompanion(
	pool: QdrantSearchHit[],
	topK: number,
	options?: { preserveFigureLineage?: boolean; lineageMinScore?: number },
): { selected: QdrantSearchHit[]; restoredFigureCount: number } {
	const selected = pool.slice(0, topK);
	const threshold = options?.lineageMinScore;
	if (
		!options?.preserveFigureLineage ||
		topK < 2 ||
		typeof threshold !== "number" ||
		!Number.isFinite(threshold) ||
		threshold < 0 ||
		threshold > 1
	)
		return { selected, restoredFigureCount: 0 };
	const selectedIds = new Set(selected.map((hit) => String(hit.id)));
	for (const [anchorIndex, anchor] of selected.entries()) {
		if (
			anchorIndex >= topK - 1 ||
			anchor.payload.record_type !== "chunk" ||
			semanticEvidenceScore(anchor) < threshold
		)
			continue;
		const directFigureId = anchor.payload.figure_id?.trim()
			? anchor.payload.figure_id
			: null;
		const anchorNodes = new Set(
			anchor.payload.source_node_ids?.filter((node) => node.trim()),
		);
		const directFigure = (hit: QdrantSearchHit) =>
			directFigureId !== null && directFigureId === hit.payload.figure_id;
		const nodeOverlap = (hit: QdrantSearchHit) =>
			hit.payload.source_node_ids?.some((node) => anchorNodes.has(node)) ??
			false;
		const isCompanion = (hit: QdrantSearchHit) =>
			hit.payload.record_type === "figure" &&
			(directFigure(hit) || nodeOverlap(hit)) &&
			sharesEvidenceLineage(anchor.payload, hit.payload);
		if (selected.some(isCompanion)) continue;
		const eligible = pool.filter(
			(hit) =>
				!selectedIds.has(String(hit.id)) &&
				isCompanion(hit) &&
				semanticEvidenceScore(hit) >= threshold,
		);
		const companion = eligible.find(directFigure) ?? eligible[0];
		if (!companion) continue;
		// Keep the direct evidence and its one companion together within the same cap.
		return {
			selected: [
				...selected.slice(0, anchorIndex + 1),
				companion,
				...selected.slice(anchorIndex + 1),
			].slice(0, topK),
			restoredFigureCount: 1,
		};
	}
	return { selected, restoredFigureCount: 0 };
}

const MAX_PARENT_CONTEXT_CHARS = 1_600;
const MIN_PARENT_EXTRA_CHARS = 40;
const SKIP_PARENT_RECORD_FILTERS = new Set([
	"document",
	"section",
	"table",
	"table_summary",
]);

function sectionKey(hit: QdrantSearchHit): string {
	return `${hit.payload.doc_id}:${hit.payload.generation_id ?? ""}:${hit.payload.record_id ?? String(hit.id)}`;
}

function isExpandableChildChunk(hit: QdrantSearchHit): boolean {
	return (
		hit.payload.record_type === "chunk" &&
		!hit.payload.table_id &&
		!hit.payload.figure_id
	);
}

function findParentSection(
	child: QdrantSearchHit,
	sections: readonly QdrantSearchHit[],
): QdrantSearchHit | null {
	const childBody = (child.payload.body || child.payload.text).trim();
	const sameScopeSections = sections.filter(
		(section) =>
			section.payload.record_type === "section" &&
			section.payload.doc_id === child.payload.doc_id &&
			section.payload.generation_id === child.payload.generation_id,
	);
	if (child.payload.parent_record_id) {
		const byParentId = sameScopeSections.find(
			(section) => section.payload.record_id === child.payload.parent_record_id,
		);
		if (byParentId) return byParentId;
	}
	if (child.payload.record_id) {
		const recordId = child.payload.record_id;
		const bySourceChunk = sameScopeSections.find((section) =>
			section.payload.source_chunk_ids?.includes(recordId),
		);
		if (bySourceChunk) return bySourceChunk;
	}
	if (child.payload.section_path && childBody) {
		const normalizedChild = childBody.replace(/\s+/g, " ");
		const byPathAndText = sameScopeSections.find((section) => {
			if (section.payload.section_path !== child.payload.section_path) {
				return false;
			}
			const sectionText = (section.payload.body || section.payload.text)
				.replace(/\s+/g, " ")
				.trim();
			return sectionText.includes(normalizedChild);
		});
		if (byPathAndText) return byPathAndText;
	}
	return null;
}

function safeSlice(text: string, start: number, end: number): string {
	let s = Math.max(0, start);
	let e = Math.min(text.length, end);
	if (
		s > 0 &&
		/[\uDC00-\uDFFF]/u.test(text.charAt(s)) &&
		/[\uD800-\uDBFF]/u.test(text.charAt(s - 1))
	) {
		s += 1;
	}
	if (
		e < text.length &&
		/[\uD800-\uDBFF]/u.test(text.charAt(e - 1)) &&
		/[\uDC00-\uDFFF]/u.test(text.charAt(e))
	) {
		e -= 1;
	}
	return text.slice(s, e).trim();
}

function boundParentWindow(
	sectionText: string,
	childText: string,
): string | null {
	const trimmedSection = sectionText.trim();
	const trimmedChild = childText.trim();
	if (
		!trimmedSection ||
		trimmedSection.length <= trimmedChild.length + MIN_PARENT_EXTRA_CHARS
	) {
		return null;
	}
	if (trimmedSection.length <= MAX_PARENT_CONTEXT_CHARS) {
		return trimmedSection;
	}
	const anchor = trimmedChild.slice(0, Math.min(80, trimmedChild.length));
	const matchPos = anchor ? trimmedSection.indexOf(anchor) : -1;
	if (matchPos < 0) {
		return safeSlice(trimmedSection, 0, MAX_PARENT_CONTEXT_CHARS);
	}
	const matchEnd = Math.min(
		trimmedSection.length,
		matchPos + trimmedChild.length,
	);
	const halfMargin = Math.max(
		0,
		Math.floor((MAX_PARENT_CONTEXT_CHARS - (matchEnd - matchPos)) / 2),
	);
	let start = Math.max(0, matchPos - halfMargin);
	const end = Math.min(trimmedSection.length, start + MAX_PARENT_CONTEXT_CHARS);
	if (end === trimmedSection.length) {
		start = Math.max(0, end - MAX_PARENT_CONTEXT_CHARS);
	}
	return safeSlice(trimmedSection, start, end);
}

async function expandParentContexts(input: {
	selected: readonly QdrantSearchHit[];
	knownSections: readonly QdrantSearchHit[];
	scope: RetrievalScope;
	store: RetrievalVectorStore;
	filters: RetrievalUserFilters;
	enabled: boolean;
	signal?: AbortSignal;
}): Promise<Map<string, string>> {
	const parentContexts = new Map<string, string>();
	if (
		!input.enabled ||
		(input.filters.record_type &&
			SKIP_PARENT_RECORD_FILTERS.has(input.filters.record_type))
	) {
		return parentContexts;
	}
	const expandable = input.selected.filter(isExpandableChildChunk);
	if (expandable.length === 0) return parentContexts;

	const selectedSectionKeys = new Set(
		input.selected
			.filter((hit) => hit.payload.record_type === "section")
			.map(sectionKey),
	);
	const sectionPool = new Map<string, QdrantSearchHit>();
	for (const hit of input.knownSections) {
		if (hit.payload.record_type === "section") {
			sectionPool.set(sectionKey(hit), hit);
		}
	}

	const unresolvedDocIds = new Set<string>();
	for (const child of expandable) {
		if (!findParentSection(child, [...sectionPool.values()])) {
			unresolvedDocIds.add(child.payload.doc_id);
		}
	}

	if (unresolvedDocIds.size > 0 && input.store.lookupSections) {
		input.signal?.throwIfAborted();
		const allowedDocIds = input.scope.documentIds
			? [...unresolvedDocIds].filter((docId) =>
					input.scope.documentIds?.includes(docId),
				)
			: [...unresolvedDocIds];
		if (allowedDocIds.length > 0) {
			try {
				const fetched = assertAuthorizedHits(
					await input.store.lookupSections({
						scope: {
							...input.scope,
							documentIds: allowedDocIds,
						},
						limit: Math.min(256, Math.max(32, allowedDocIds.length * 32)),
					}),
					input.scope,
				);
				for (const hit of fetched) {
					if (hit.payload.record_type === "section") {
						sectionPool.set(sectionKey(hit), hit);
					}
				}
			} catch (error) {
				input.signal?.throwIfAborted();
				if (error instanceof RetrievalSecurityViolationError) throw error;
			}
		}
	}

	const allSections = [...sectionPool.values()];
	const attachedSectionKeys = new Set(selectedSectionKeys);
	const fallbackChildren: QdrantSearchHit[] = [];
	for (const child of expandable) {
		const parent = findParentSection(child, allSections);
		if (!parent) {
			fallbackChildren.push(child);
			continue;
		}
		const key = sectionKey(parent);
		if (attachedSectionKeys.has(key)) continue;
		const bounded = boundParentWindow(
			parent.payload.body || parent.payload.text,
			child.payload.body || child.payload.text,
		);
		if (!bounded) {
			fallbackChildren.push(child);
			continue;
		}
		attachedSectionKeys.add(key);
		parentContexts.set(String(child.id), bounded);
	}
	// Sibling-chunk fallback when a chunk has no parent section or spans across chunk boundaries.
	if (fallbackChildren.length > 0 && input.store.lookupChunks) {
		const selectedChunkKeys = new Set(
			input.selected
				.filter((hit) => hit.payload.record_type === "chunk")
				.map(
					(hit) =>
						`${hit.payload.doc_id}:${hit.payload.generation_id ?? ""}:${hit.payload.chunk_index}`,
				),
		);
		const fallbackDocIds = [
			...new Set(fallbackChildren.map((child) => child.payload.doc_id)),
		];
		const allowedDocIds = input.scope.documentIds
			? fallbackDocIds.filter((docId) =>
					input.scope.documentIds?.includes(docId),
				)
			: fallbackDocIds;
		if (allowedDocIds.length > 0) {
			try {
				input.signal?.throwIfAborted();
				const siblingCandidates = assertAuthorizedHits(
					await input.store.lookupChunks({
						scope: {
							...input.scope,
							documentIds: allowedDocIds,
						},
						limit: Math.min(256, Math.max(48, allowedDocIds.length * 48)),
					}),
					input.scope,
				);
				const chunkByIndex = new Map<string, QdrantSearchHit>();
				for (const hit of siblingCandidates) {
					if (isExpandableChildChunk(hit)) {
						chunkByIndex.set(
							`${hit.payload.doc_id}:${hit.payload.generation_id ?? ""}:${hit.payload.chunk_index}`,
							hit,
						);
					}
				}
				for (const child of fallbackChildren) {
					const prefix = `${child.payload.doc_id}:${child.payload.generation_id ?? ""}`;
					const prevKey = `${prefix}:${child.payload.chunk_index - 1}`;
					const nextKey = `${prefix}:${child.payload.chunk_index + 1}`;
					const neighbors = [
						!selectedChunkKeys.has(prevKey)
							? chunkByIndex.get(prevKey)
							: undefined,
						!selectedChunkKeys.has(nextKey)
							? chunkByIndex.get(nextKey)
							: undefined,
					].filter((hit): hit is QdrantSearchHit => Boolean(hit));
					if (neighbors.length === 0) continue;
					const combined = [
						...neighbors
							.filter((n) => n.payload.chunk_index < child.payload.chunk_index)
							.map((n) => (n.payload.body || n.payload.text).trim()),
						(child.payload.body || child.payload.text).trim(),
						...neighbors
							.filter((n) => n.payload.chunk_index > child.payload.chunk_index)
							.map((n) => (n.payload.body || n.payload.text).trim()),
					]
						.filter(Boolean)
						.join("\n\n");
					const bounded = boundParentWindow(
						combined,
						child.payload.body || child.payload.text,
					);
					if (bounded) {
						parentContexts.set(String(child.id), bounded);
					}
				}
			} catch (error) {
				input.signal?.throwIfAborted();
				if (error instanceof RetrievalSecurityViolationError) throw error;
			}
		}
	}
	return parentContexts;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function countCandidates(hits: QdrantSearchHit[]): CandidateCounts {
	const byRecordType: CandidateCounts["byRecordType"] = {
		chunk: 0,
		section: 0,
		document: 0,
		table: 0,
		table_summary: 0,
		figure: 0,
	};
	for (const hit of hits) {
		if (Object.hasOwn(byRecordType, hit.payload.record_type)) {
			byRecordType[hit.payload.record_type] += 1;
		}
	}
	return { total: hits.length, byRecordType };
}

function diagnosticCounts(
	counts: CandidateCounts,
	stage: "BeforeRerank" | "AfterRerank" | "AfterDedup" | "AfterTopK",
): Record<string, number> {
	return {
		[`candidateCount${stage}`]: counts.total,
		[`chunkCount${stage}`]: counts.byRecordType.chunk,
		[`sectionCount${stage}`]: counts.byRecordType.section,
		[`documentCount${stage}`]: counts.byRecordType.document,
		[`tableCount${stage}`]: counts.byRecordType.table,
		[`tableSummaryCount${stage}`]: counts.byRecordType.table_summary,
		[`figureCount${stage}`]: counts.byRecordType.figure,
	};
}

export class DefaultRetrievalService {
	constructor(
		private readonly embeddings: EmbeddingProvider,
		private readonly store: RetrievalVectorStore,
		private readonly reranker: RerankProvider | null,
		private readonly options: RetrievalServiceOptions,
	) {}

	async lookupDocumentRecord(input: {
		libraryId: string;
		scope: AuthorizedScope;
		documentId: string;
		generationId: string;
		expectedBody: string;
		filters?: RetrievalFilters;
		signal?: AbortSignal;
	}): Promise<InternalCitation | null> {
		input.signal?.throwIfAborted();
		const scope = toRetrievalScope(input.scope, input.libraryId);
		if (
			!scope.activeGenerationIds.includes(input.generationId) ||
			(scope.documentIds && !scope.documentIds.includes(input.documentId)) ||
			(input.filters?.doc_id && input.filters.doc_id !== input.documentId) ||
			input.filters?.table_id ||
			(input.filters?.record_type && input.filters.record_type !== "document")
		)
			return null;
		const narrowScope = {
			...scope,
			documentIds: [input.documentId],
			activeGenerationIds: [input.generationId],
		};
		const hits = assertAuthorizedHits(
			await this.store.listCorpus({
				scope: narrowScope,
				userFilters: {
					...toUserFilters(input.filters),
					record_type: "document",
				},
				limit: 2,
			}),
			narrowScope,
		);
		input.signal?.throwIfAborted();
		const hit = hits.length === 1 ? hits[0] : null;
		if (
			hit?.payload.record_type !== "document" ||
			(input.filters?.document_version_id &&
				hit.payload.document_version_id !==
					input.filters.document_version_id) ||
			(hit.payload.body || hit.payload.text) !== input.expectedBody
		)
			return null;
		// An exact structured lookup is not a semantic similarity score.
		return mapQdrantHitToInternalCitation(
			{ ...hit, score: 0, dense_score: null },
			1,
		);
	}

	async retrieve(input: {
		query: string;
		libraryId: string;
		scope: AuthorizedScope;
		topK: number;
		filters?: RetrievalFilters;
		options?: {
			hybridEnabled?: boolean;
			rerankEnabled?: boolean;
			preserveFigureLineage?: boolean;
			lineageMinScore?: number;
			expandParentContext?: boolean;
		};
		signal?: AbortSignal;
	}): Promise<RetrievalResult> {
		input.signal?.throwIfAborted();
		const query = input.query.trim();
		if (!query) throw new Error("query is required");
		if (!Number.isInteger(input.topK) || input.topK < 1 || input.topK > 50) {
			throw new Error("topK must be an integer between 1 and 50");
		}
		const scope = toRetrievalScope(input.scope, input.libraryId);
		const filters = toUserFilters(input.filters);
		const expandParentContext = input.options?.expandParentContext ?? true;
		const cacheKey = this.options.cache
			? buildScopedRetrievalCacheKey({
					query,
					libraryId: input.libraryId,
					scope: input.scope,
					topK: input.topK,
					filters,
					options: {
						hybridEnabled:
							input.options?.hybridEnabled ?? this.options.hybridEnabled,
						rerankEnabled:
							input.options?.rerankEnabled ?? this.options.rerankEnabled,
						preserveFigureLineage: input.options?.preserveFigureLineage,
						lineageMinScore: input.options?.lineageMinScore,
						expandParentContext,
						rerankTopK: this.options.rerankTopK,
						bm25TopK: this.options.bm25TopK,
						rrfK: this.options.rrfK,
					},
				})
			: null;
		const cached = cacheKey ? this.options.cache?.get(cacheKey) : null;
		if (cached) {
			return cached;
		}
		const denseK = Math.max(
			input.topK,
			this.options.rerankTopK,
			this.options.bm25TopK,
		);
		const vector = await this.embeddings.embedQuery(query, input.signal);
		input.signal?.throwIfAborted();
		const dense = assertAuthorizedHits(
			await this.store.search({
				vector,
				scope,
				userFilters: filters,
				limit: denseK,
			}),
			scope,
		);
		let candidates = dense;
		const knownSections: QdrantSearchHit[] = dense.filter(
			(hit) => hit.payload.record_type === "section",
		);
		let usedHybrid = false;
		let hybridError: string | null = null;
		const hybridEnabled =
			input.options?.hybridEnabled ?? this.options.hybridEnabled;
		const rerankEnabled =
			input.options?.rerankEnabled ?? this.options.rerankEnabled;
		if (hybridEnabled) {
			try {
				const serverHits = await this.store.hybridSearch?.({
					vector,
					query,
					scope,
					userFilters: filters,
					limit: denseK,
					sparseLimit: this.options.bm25TopK,
					rrfK: this.options.rrfK,
				});
				if (serverHits != null) {
					const denseScores = new Map(
						dense.map((hit) => [String(hit.id), hit.score]),
					);
					candidates = assertAuthorizedHits(serverHits, scope).map((hit) => ({
						...hit,
						dense_score: denseScores.get(String(hit.id)) ?? null,
						rrf_score: hit.score,
						used_hybrid: true,
					}));
					for (const hit of candidates) {
						if (hit.payload.record_type === "section") knownSections.push(hit);
					}
					usedHybrid = true;
				}
			} catch (error) {
				input.signal?.throwIfAborted();
				if (error instanceof RetrievalSecurityViolationError) throw error;
				hybridError = errorMessage(error);
				candidates = dense;
			}
		}

		input.signal?.throwIfAborted();
		const beforeRerank = countCandidates(candidates);
		let rerankFailed = false;
		let usedRerank = false;
		let rerankDiagnostics:
			| (RetrievalProviderDiagnostic & {
					inputCount: number;
					requestedCount: number;
					resultCount: number | null;
			  })
			| undefined;
		if (rerankEnabled && this.reranker && candidates.length > 1) {
			const startedAt = Date.now();
			const requestedCount = Math.min(input.topK, candidates.length);
			rerankDiagnostics = {
				inputCount: candidates.length,
				requestedCount,
				resultCount: null,
				durationMs: 0,
				category: "success",
				statusCode: null,
				attempts: null,
				timeoutMs: null,
				maxAttempts: null,
			};
			let receivedResponse = false;
			try {
				const response = await this.reranker.rerank({
					query,
					documents: candidates.map(hitText),
					topN: requestedCount,
					signal: input.signal,
				});
				input.signal?.throwIfAborted();
				receivedResponse = true;
				const ranked = normalizeRerankResults(response, candidates.length);
				rerankDiagnostics.resultCount = ranked.length;
				const reranked = ranked.map((rank) => ({
					...candidates[rank.index],
					score: rank.score,
					used_rerank: true,
				}));
				if (reranked.length) {
					const rerankedIds = new Set(reranked.map((hit) => String(hit.id)));
					candidates = [
						...reranked,
						...candidates.filter((hit) => !rerankedIds.has(String(hit.id))),
					];
					usedRerank = true;
				}
			} catch (error) {
				input.signal?.throwIfAborted();
				rerankFailed = true;
				const failure =
					error instanceof RetrievalProviderError
						? error
						: new RetrievalProviderError({
								provider: "rerank",
								kind: receivedResponse ? "invalid_response" : "unknown",
								retryable: false,
								cause: error,
								durationMs: Math.max(0, Date.now() - startedAt),
							});
				Object.assign(rerankDiagnostics, failure.diagnostics);
			} finally {
				rerankDiagnostics.durationMs = Math.max(0, Date.now() - startedAt);
			}
		}

		input.signal?.throwIfAborted();
		const afterRerank = countCandidates(candidates);
		const deduplicated = deduplicateOverlappingHits(candidates);
		const { selected, restoredFigureCount } = retainFigureCompanion(
			deduplicated,
			input.topK,
			input.options,
		);
		const parentContexts = await expandParentContexts({
			selected,
			knownSections,
			scope,
			store: this.store,
			filters,
			enabled: expandParentContext,
			signal: input.signal,
		});
		const rerankDiagnostic =
			rerankDiagnostics &&
			projectRerankDiagnostic({
				...rerankDiagnostics,
				restoredFigureCount,
				...diagnosticCounts(beforeRerank, "BeforeRerank"),
				...diagnosticCounts(afterRerank, "AfterRerank"),
				...diagnosticCounts(countCandidates(deduplicated), "AfterDedup"),
				...diagnosticCounts(countCandidates(selected), "AfterTopK"),
			});
		const citations = selected.map((hit, index) =>
			mapQdrantHitToInternalCitation(
				{ ...hit, used_hybrid: usedHybrid },
				index + 1,
				parentContexts.get(String(hit.id)),
			),
		);
		const result: RetrievalResult = {
			citations,
			debug: {
				usedHybrid,
				hybridEnabled,
				hybridFailed: hybridError !== null,
				hybridError,
				usedRerank,
				rerankFailed,
				retrievalMode: usedHybrid ? "hybrid" : "dense",
				denseHitCount: dense.length,
				activeGenerationCount: scope.activeGenerationIds.length,
				...(rerankDiagnostic ? { rerankDiagnostic } : {}),
			},
		};
		if (cacheKey) {
			this.options.cache?.set(cacheKey, result);
		}
		return result;
	}
}

export type { StoredQdrantPayload };
