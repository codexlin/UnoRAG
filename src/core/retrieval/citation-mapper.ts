import { type InternalCitation, InternalCitationSchema } from "./contracts";
import { parseQdrantSearchHit, type QdrantSearchHit } from "./qdrant/payload";

export const PARENT_CONTEXT_SEPARATOR = "\n\n所属章节完整上下文：\n";

function nullableNumber(value: number | null | undefined): number | null {
	return value ?? null;
}

function nullableString(value: string | null | undefined): string | null {
	return value ?? null;
}

function clampScore(score: number): number {
	return Math.max(0, Math.min(1, score));
}

export function formatCitationEvidenceText(source: {
	body?: unknown;
	text?: unknown;
	snippet?: unknown;
	parent_context?: unknown;
}): string {
	const primary = (
		typeof source.body === "string" && source.body
			? source.body
			: typeof source.text === "string" && source.text
				? source.text
				: typeof source.snippet === "string"
					? source.snippet
					: ""
	).trim();
	const parent =
		typeof source.parent_context === "string"
			? source.parent_context.trim()
			: "";
	if (!parent || parent === primary) return primary;
	return primary ? primary + PARENT_CONTEXT_SEPARATOR + parent : parent;
}

export function semanticEvidenceScore(input: {
	score: number;
	dense_score?: number | null;
	lexical_score?: number | null;
	sparse_score?: number | null;
	bm25_score?: number | null;
	rrf_score?: number | null;
	used_hybrid?: boolean;
	used_rerank?: boolean;
}): number {
	if (input.used_hybrid && !input.used_rerank && input.dense_score == null) {
		const lexical = input.lexical_score ?? input.sparse_score;
		if (typeof lexical === "number" && Number.isFinite(lexical)) {
			return clampScore(lexical);
		}
		const bm25 = input.bm25_score;
		if (typeof bm25 === "number" && Number.isFinite(bm25) && bm25 > 0) {
			return bm25 / (1 + bm25);
		}
		// A standalone score can be a relevance score. An RRF score is only a rank.
		return input.rrf_score == null && Number.isFinite(input.score)
			? clampScore(input.score)
			: Number.NEGATIVE_INFINITY;
	}
	const score =
		input.used_hybrid && !input.used_rerank ? input.dense_score : input.score;
	return typeof score === "number" && Number.isFinite(score)
		? score
		: Number.NEGATIVE_INFINITY;
}

export function mapQdrantHitToInternalCitation(
	input: QdrantSearchHit | unknown,
	index: number,
	parentContext?: string | null,
): InternalCitation {
	const hit = parseQdrantSearchHit(input);
	if (!hit) throw new TypeError("invalid Qdrant search hit");
	if (!Number.isInteger(index) || index < 1) {
		throw new RangeError("citation index must be a positive integer");
	}

	const payload = hit.payload;
	const body = payload.body || payload.text;
	const parentRecordId = nullableString(payload.parent_record_id);
	const resolvedParentContext =
		typeof parentContext === "string" && parentContext.trim()
			? parentContext.trim()
			: null;
	return InternalCitationSchema.parse({
		id: String(hit.id),
		index,
		title: payload.title || "未命名文档",
		page:
			payload.page === null || payload.page === undefined
				? null
				: String(payload.page),
		page_start: nullableNumber(payload.page_start),
		page_end: nullableNumber(payload.page_end),
		section_path: nullableString(payload.section_path),
		heading_text: nullableString(payload.heading_text),
		preamble: nullableString(payload.preamble),
		table_id: nullableString(payload.table_id),
		figure_id: nullableString(payload.figure_id),
		headers: payload.headers ?? [],
		rows: payload.rows ?? [],
		row_start: nullableNumber(payload.row_start),
		row_end: nullableNumber(payload.row_end),
		table_row_count: nullableNumber(payload.table_row_count),
		snippet: body.slice(0, 280),
		score: clampScore(hit.score),
		dense_score: hit.dense_score === undefined ? hit.score : hit.dense_score,
		bm25_score: hit.bm25_score ?? null,
		...(hit.lexical_score != null ? { lexical_score: hit.lexical_score } : {}),
		...(hit.sparse_score != null ? { sparse_score: hit.sparse_score } : {}),
		rrf_score: hit.rrf_score ?? null,
		used_rerank: hit.used_rerank ?? false,
		used_hybrid: hit.used_hybrid ?? false,
		text: body,
		body,
		library_id: payload.library_id,
		doc_id: payload.doc_id,
		chunk_index: payload.chunk_index,
		filename: nullableString(payload.filename),
		document_version_id: payload.document_version_id,
		generation_id: nullableString(payload.generation_id),
		tenant_id: payload.tenant_id,
		workspace_id: payload.workspace_id,
		record_type: payload.record_type,
		record_id: nullableString(payload.record_id),
		...(parentRecordId ? { parent_record_id: parentRecordId } : {}),
		...(resolvedParentContext ? { parent_context: resolvedParentContext } : {}),
		source_chunk_ids: payload.source_chunk_ids ?? [],
		source_node_ids: payload.source_node_ids ?? [],
	});
}
