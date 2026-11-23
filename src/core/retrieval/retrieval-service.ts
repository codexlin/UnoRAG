import type { AuthorizedScope, RetrievalFilters } from "../contracts";
import {
	estimateTokens,
	sliceAroundTokenBudget,
	sliceByTokenBudget,
} from "../text/token-estimate";
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
import { tokenize } from "./hybrid/tokenizer";
import {
	projectRerankDiagnostic,
	type RerankDiagnostic,
	type RetrievalProviderDiagnostic,
	RetrievalProviderError,
} from "./provider-request";
import type { QdrantSearchHit, StoredQdrantPayload } from "./qdrant/payload";
import type {
	ChunkLookupTarget,
	RetrievalVectorStore,
	SectionLookupTarget,
} from "./qdrant/store";
import { normalizeRerankResults, type RerankProvider } from "./rerank/provider";
import {
	buildScopedRetrievalCacheKey,
	type ScopedRetrievalCache,
} from "./retrieval-cache";

type CandidateCounts = {
	total: number;
	byRecordType: Record<StoredQdrantPayload["record_type"], number>;
};

export type RetrievalInspectionCandidate = {
	id: string;
	document_id: string;
	title: string;
	filename: string | null;
	section_path: string | null;
	record_type: string;
	page_start: number | null;
	page_end: number | null;
	coarse_rank: number;
	rerank_rank: number | null;
	rank_delta: number | null;
	final_rank: number | null;
	dense_score: number | null;
	sparse_score: number | null;
	rrf_score: number | null;
	rerank_score: number | null;
	outcome:
		| "selected"
		| "deduped"
		| "below_threshold"
		| "dropped_topk"
		| "dropped_rerank";
	parent_expanded: boolean;
	chars_before_expand: number;
	chars_after_expand: number;
	preview: string;
};

export type RetrievalInspection = {
	query: string;
	mode: "dense" | "hybrid";
	usedRerank: boolean;
	topK: number;
	evidenceThreshold: number | null;
	candidates: RetrievalInspectionCandidate[];
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
	inspection?: RetrievalInspection;
};

export type RetrievalResult = {
	citations: InternalCitation[];
	debug: RetrievalDebug;
	/** Scope lineage for live reauthorization of inspected hits, including drops. */
	inspectionReferences?: Pick<
		StoredQdrantPayload,
		| "doc_id"
		| "document_version_id"
		| "generation_id"
		| "library_id"
		| "tenant_id"
		| "workspace_id"
	>[];
};

export type RetrievalServiceOptions = {
	hybridEnabled: boolean;
	hybridAllowed?: boolean;
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

function lexicalIdentifiers(text: string): Set<string> {
	const normalized = text
		.normalize("NFKC")
		.toLowerCase()
		.replace(/\p{Dash_Punctuation}/gu, "-");
	const words = normalized.match(/[a-z0-9]+(?:[-_./][a-z0-9]+)*/gu) ?? [];
	return new Set(
		words.filter((word) => /^[a-z]/u.test(word) && /\d/u.test(word)),
	);
}

function lexicalEvidenceScorer(
	query: string,
): (hit: QdrantSearchHit) => number {
	const tokens = [...new Set(tokenize(query))];
	// When bigrams are available, scattered Han characters alone do not
	// establish that the candidate matched query terms.
	const terms = tokens.some(
		(term) => term.length > 1 && /\p{Script=Han}/u.test(term),
	)
		? tokens.filter((term) => !/^\p{Script=Han}$/u.test(term))
		: tokens;
	const identifiers = [...lexicalIdentifiers(query)];
	return (hit) => {
		const text = hitText(hit);
		const matched = new Set(tokenize(text));
		const termCoverage = terms.length
			? terms.filter((term) => matched.has(term)).length / terms.length
			: 0;
		if (!identifiers.length) return termCoverage;
		const matchedIdentifiers = lexicalIdentifiers(text);
		const identifierCoverage =
			identifiers.filter((identifier) => matchedIdentifiers.has(identifier))
				.length / identifiers.length;
		return Math.max(termCoverage, identifierCoverage);
	};
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
	// Lineage can insert an image from outside Top-K. Keep its original
	// dense/reranked relevance gate even when lexical evidence is eligible for recall.
	const passesLineageThreshold = (hit: QdrantSearchHit) =>
		(!hit.used_hybrid || hit.used_rerank || hit.dense_score != null) &&
		semanticEvidenceScore(hit) >= threshold;
	const selectedIds = new Set(selected.map((hit) => String(hit.id)));
	for (const [anchorIndex, anchor] of selected.entries()) {
		if (
			anchorIndex >= topK - 1 ||
			anchor.payload.record_type !== "chunk" ||
			!passesLineageThreshold(anchor)
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
				passesLineageThreshold(hit),
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

const MAX_PARENT_CONTEXT_TOKENS = 1_200;
const MAX_PARENT_CONTEXT_HARD_CHARS = 4_500;
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
			section.payload.generation_id === child.payload.generation_id &&
			(section.payload.section_instance ?? null) ===
				(child.payload.section_instance ?? null),
	);
	if (child.payload.parent_record_id) {
		return (
			sameScopeSections.find(
				(section) =>
					section.payload.record_id === child.payload.parent_record_id,
			) ?? null
		);
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

function parentLookupTarget(child: QdrantSearchHit): SectionLookupTarget[] {
	const {
		doc_id,
		generation_id,
		parent_record_id,
		record_id,
		section_path,
		section_instance,
	} = child.payload;
	if (!generation_id) return [];
	const identity = {
		documentId: doc_id,
		generationId: generation_id,
		...(section_instance == null ? {} : { sectionInstance: section_instance }),
	};
	if (parent_record_id)
		return [{ ...identity, parentRecordId: parent_record_id }];
	if (record_id) return [{ ...identity, childRecordId: record_id }];
	return section_path ? [{ ...identity, sectionPath: section_path }] : [];
}

function chunkLocation(
	hit: QdrantSearchHit,
	chunkIndex = hit.payload.chunk_index,
) {
	return {
		documentId: hit.payload.doc_id,
		generationId: hit.payload.generation_id ?? "",
		chunkIndex,
		sectionPath: hit.payload.section_path ?? null,
		...(hit.payload.section_instance == null
			? {}
			: { sectionInstance: hit.payload.section_instance }),
	} satisfies ChunkLookupTarget;
}

function chunkLocationKey(target: ChunkLookupTarget): string {
	return JSON.stringify([
		target.documentId,
		target.generationId,
		target.chunkIndex,
		target.sectionPath,
		target.sectionInstance ?? null,
	]);
}

function expansionScope(
	scope: RetrievalScope,
	targets: readonly (SectionLookupTarget | ChunkLookupTarget)[],
): RetrievalScope {
	return {
		...scope,
		documentIds: [...new Set(targets.map((target) => target.documentId))],
		activeGenerationIds: [
			...new Set(targets.map((target) => target.generationId)),
		],
	};
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

function inspectCandidates(input: {
	coarse: QdrantSearchHit[];
	reranked: Map<string, { rank: number; score: number }>;
	deduplicated: QdrantSearchHit[];
	citations: InternalCitation[];
	evidenceThreshold: number | null;
	usedHybrid: boolean;
	belowThresholdIds?: ReadonlySet<string>;
}): RetrievalInspectionCandidate[] {
	const deduplicatedIds = new Set(
		input.deduplicated.map(({ id }) => String(id)),
	);
	const citations = new Map(
		input.citations.map((citation) => [citation.id, citation]),
	);
	let finalRank = 0;
	const finalRanks = new Map<string, number>();
	for (const citation of input.citations) {
		if (
			input.evidenceThreshold === null ||
			semanticEvidenceScore(citation) >= input.evidenceThreshold
		) {
			finalRanks.set(citation.id, ++finalRank);
		}
	}
	return input.coarse.map((hit, index) => {
		const id = String(hit.id);
		const payload = hit.payload;
		const ranked = input.reranked.get(id);
		const citation = citations.get(id);
		const coarseRank = index + 1;
		const body = (payload.body || payload.text).trim();
		const parent = citation?.parent_context;
		const rank = finalRanks.get(id) ?? null;
		let outcome: RetrievalInspectionCandidate["outcome"];
		if (rank !== null) outcome = "selected";
		else if (citation || input.belowThresholdIds?.has(id))
			outcome = "below_threshold";
		else if (input.reranked.size && !ranked) outcome = "dropped_rerank";
		else if (!deduplicatedIds.has(id)) outcome = "deduped";
		else outcome = "dropped_topk";
		return {
			id,
			document_id: payload.doc_id,
			title: safeSlice(payload.title || "未命名文档", 0, 300),
			filename:
				payload.filename == null ? null : safeSlice(payload.filename, 0, 300),
			section_path:
				payload.section_path == null
					? null
					: safeSlice(payload.section_path, 0, 300),
			record_type: payload.record_type,
			page_start: payload.page_start ?? null,
			page_end: payload.page_end ?? null,
			coarse_rank: coarseRank,
			rerank_rank: ranked?.rank ?? null,
			rank_delta: ranked ? coarseRank - ranked.rank : null,
			final_rank: rank,
			dense_score:
				hit.dense_score === undefined && !input.usedHybrid
					? hit.score
					: (hit.dense_score ?? null),
			sparse_score: hit.sparse_score ?? hit.bm25_score ?? null,
			rrf_score: hit.rrf_score ?? null,
			rerank_score: ranked?.score ?? null,
			outcome,
			parent_expanded: !!parent,
			chars_before_expand: body.length,
			chars_after_expand: parent?.length ?? body.length,
			preview: safeSlice(body.replace(/\s+/gu, " "), 0, 300),
		};
	});
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
	if (
		trimmedSection.length <= MAX_PARENT_CONTEXT_HARD_CHARS &&
		estimateTokens(trimmedSection) <= MAX_PARENT_CONTEXT_TOKENS
	) {
		return trimmedSection;
	}
	let anchor = trimmedChild;
	let matchPos = anchor ? trimmedSection.indexOf(anchor) : -1;
	if (matchPos < 0 && trimmedChild) {
		anchor = sliceByTokenBudget(trimmedChild, Number.POSITIVE_INFINITY, 80);
		matchPos = trimmedSection.indexOf(anchor);
	}
	const bounded = (
		matchPos < 0
			? sliceByTokenBudget(
					trimmedSection,
					MAX_PARENT_CONTEXT_TOKENS,
					MAX_PARENT_CONTEXT_HARD_CHARS,
				)
			: sliceAroundTokenBudget(
					trimmedSection,
					matchPos,
					matchPos + anchor.length,
					MAX_PARENT_CONTEXT_TOKENS,
					MAX_PARENT_CONTEXT_HARD_CHARS,
				)
	).trim();
	return bounded.length > trimmedChild.length + MIN_PARENT_EXTRA_CHARS
		? bounded
		: null;
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

	const knownSections = [...sectionPool.values()];
	const parentTargets = expandable
		.filter((child) => !findParentSection(child, knownSections))
		.flatMap(parentLookupTarget);
	if (parentTargets.length && input.store.lookupSections) {
		input.signal?.throwIfAborted();
		try {
			const scope = expansionScope(input.scope, parentTargets);
			const fetched = assertAuthorizedHits(
				await input.store.lookupSections({ scope, targets: parentTargets }),
				scope,
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
				.map((hit) => chunkLocationKey(chunkLocation(hit))),
		);
		const neighborTargets = new Map<string, ChunkLookupTarget>();
		for (const child of fallbackChildren) {
			for (const offset of [-1, 1]) {
				const target = chunkLocation(child, child.payload.chunk_index + offset);
				const key = chunkLocationKey(target);
				if (target.chunkIndex >= 0 && !selectedChunkKeys.has(key)) {
					neighborTargets.set(key, target);
				}
			}
		}
		const targets = [...neighborTargets.values()];
		if (targets.length > 0) {
			try {
				input.signal?.throwIfAborted();
				const scope = expansionScope(input.scope, targets);
				const siblingCandidates = assertAuthorizedHits(
					await input.store.lookupChunks({ scope, targets }),
					scope,
				);
				const neighborsByLocation = new Map<string, QdrantSearchHit>();
				for (const hit of siblingCandidates) {
					const key = chunkLocationKey(chunkLocation(hit));
					if (neighborTargets.has(key) && isExpandableChildChunk(hit)) {
						neighborsByLocation.set(key, hit);
					}
				}
				for (const child of fallbackChildren) {
					const previous = neighborsByLocation.get(
						chunkLocationKey(
							chunkLocation(child, child.payload.chunk_index - 1),
						),
					);
					const next = neighborsByLocation.get(
						chunkLocationKey(
							chunkLocation(child, child.payload.chunk_index + 1),
						),
					);
					if (!previous && !next) continue;
					const combined = [previous, child, next]
						.flatMap((hit) =>
							hit ? [(hit.payload.body || hit.payload.text).trim()] : [],
						)
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
			/** Ask-only selection floor; omit to retain Public Retrieve ranking semantics. */
			minimumEvidenceScore?: number;
			expandParentContext?: boolean;
			includeTraceDetails?: boolean;
			/** Applied by Ask after Top-K. Used here to describe the trace only. */
			evidenceThreshold?: number;
		};
		signal?: AbortSignal;
	}): Promise<RetrievalResult> {
		input.signal?.throwIfAborted();
		const query = input.query.trim();
		if (!query) throw new Error("query is required");
		if (!Number.isInteger(input.topK) || input.topK < 1 || input.topK > 50) {
			throw new Error("topK must be an integer between 1 and 50");
		}
		const minimumEvidenceScore = input.options?.minimumEvidenceScore;
		if (
			minimumEvidenceScore !== undefined &&
			(!Number.isFinite(minimumEvidenceScore) ||
				minimumEvidenceScore < 0 ||
				minimumEvidenceScore > 1)
		) {
			throw new RangeError("minimumEvidenceScore must be between 0 and 1");
		}
		const scope = toRetrievalScope(input.scope, input.libraryId);
		const filters = toUserFilters(input.filters);
		const expandParentContext = input.options?.expandParentContext ?? true;
		const includeTraceDetails = input.options?.includeTraceDetails === true;
		const hybridEnabled =
			this.options.hybridAllowed !== false &&
			(input.options?.hybridEnabled ?? this.options.hybridEnabled);
		const cacheKey =
			this.options.cache && !includeTraceDetails
				? buildScopedRetrievalCacheKey({
						query,
						libraryId: input.libraryId,
						scope: input.scope,
						topK: input.topK,
						filters,
						options: {
							hybridEnabled,
							rerankEnabled:
								input.options?.rerankEnabled ?? this.options.rerankEnabled,
							preserveFigureLineage: input.options?.preserveFigureLineage,
							lineageMinScore: input.options?.lineageMinScore,
							minimumEvidenceScore,
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
					const lexicalEvidenceScore = lexicalEvidenceScorer(query);
					candidates = assertAuthorizedHits(serverHits, scope).map((hit) => {
						const denseScore = denseScores.get(String(hit.id)) ?? null;
						return {
							...hit,
							dense_score: denseScore,
							...(denseScore === null &&
							hit.sparse_score == null &&
							hit.bm25_score == null
								? {
										lexical_score:
											hit.lexical_score ?? lexicalEvidenceScore(hit),
									}
								: {}),
							rrf_score: hit.score,
							used_hybrid: true,
						};
					});
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

		if (usedHybrid && minimumEvidenceScore !== undefined) {
			// Fusion can omit a strong dense hit. Reuse only this query's authorized dense pool.
			const fusedIds = new Set(candidates.map(({ id }) => String(id)));
			candidates = [
				...candidates,
				...dense
					.filter(
						(hit) =>
							!fusedIds.has(String(hit.id)) &&
							semanticEvidenceScore(hit) >= minimumEvidenceScore,
					)
					.map((hit) => ({
						...hit,
						dense_score: hit.score,
						rrf_score: null,
						used_hybrid: true,
					})),
			];
		}

		input.signal?.throwIfAborted();
		const beforeRerank = countCandidates(candidates);
		const coarse = includeTraceDetails ? candidates.slice(0, 20) : undefined;
		const rerankPositions = coarse
			? new Map<string, { rank: number; score: number }>()
			: undefined;
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
			// Keep enough scored candidates to fill Top-K after overlap deduplication.
			const requestedCount = candidates.length;
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
					dense_score:
						candidates[rank.index].dense_score === undefined
							? candidates[rank.index].score
							: candidates[rank.index].dense_score,
					score: rank.score,
					used_rerank: true,
				}));
				if (reranked.length) {
					if (rerankPositions) {
						for (const [position, hit] of reranked.entries()) {
							rerankPositions.set(String(hit.id), {
								rank: position + 1,
								score: hit.score,
							});
						}
					}
					candidates = reranked;
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
		const eligible =
			minimumEvidenceScore === undefined
				? candidates
				: candidates.filter(
						(hit) => semanticEvidenceScore(hit) >= minimumEvidenceScore,
					);
		const belowThresholdIds =
			includeTraceDetails && minimumEvidenceScore !== undefined
				? new Set(
						candidates
							.filter(
								(hit) => semanticEvidenceScore(hit) < minimumEvidenceScore,
							)
							.map(({ id }) => String(id)),
					)
				: undefined;
		const deduplicated = deduplicateOverlappingHits(eligible);
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
		const mode = usedHybrid ? "hybrid" : "dense";
		const threshold = input.options?.evidenceThreshold ?? minimumEvidenceScore;
		const evidenceThreshold =
			typeof threshold === "number" && Number.isFinite(threshold)
				? threshold
				: null;
		const result: RetrievalResult = {
			citations,
			...(coarse
				? {
						inspectionReferences: coarse.map(({ payload }) => ({
							doc_id: payload.doc_id,
							document_version_id: payload.document_version_id,
							generation_id: payload.generation_id,
							library_id: payload.library_id,
							tenant_id: payload.tenant_id,
							workspace_id: payload.workspace_id,
						})),
					}
				: {}),
			debug: {
				usedHybrid,
				hybridEnabled,
				hybridFailed: hybridError !== null,
				hybridError,
				usedRerank,
				rerankFailed,
				retrievalMode: mode,
				denseHitCount: dense.length,
				activeGenerationCount: scope.activeGenerationIds.length,
				...(rerankDiagnostic ? { rerankDiagnostic } : {}),
				...(coarse && rerankPositions
					? {
							inspection: {
								query: safeSlice(query, 0, 300),
								mode,
								usedRerank,
								topK: input.topK,
								evidenceThreshold,
								candidates: inspectCandidates({
									coarse,
									reranked: rerankPositions,
									deduplicated,
									citations,
									evidenceThreshold,
									usedHybrid,
									belowThresholdIds,
								}),
							},
						}
					: {}),
			},
		};
		if (cacheKey && !result.debug.hybridFailed && !result.debug.rerankFailed) {
			this.options.cache?.set(cacheKey, result);
		}
		return result;
	}
}

export type { StoredQdrantPayload };
