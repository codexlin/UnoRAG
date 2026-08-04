import { type InternalCitation, InternalCitationSchema } from "./contracts";
import { parseQdrantSearchHit, type QdrantSearchHit } from "./qdrant/payload";

function nullableNumber(value: number | null | undefined): number | null {
	return value ?? null;
}

function nullableString(value: string | null | undefined): string | null {
	return value ?? null;
}

function clampScore(score: number): number {
	return Math.max(0, Math.min(1, score));
}

export function mapQdrantHitToInternalCitation(
	input: QdrantSearchHit | unknown,
	index: number,
): InternalCitation {
	const hit = parseQdrantSearchHit(input);
	if (!hit) throw new TypeError("invalid Qdrant search hit");
	if (!Number.isInteger(index) || index < 1) {
		throw new RangeError("citation index must be a positive integer");
	}

	const payload = hit.payload;
	const body = payload.body || payload.text;
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
		dense_score: hit.dense_score ?? hit.score,
		bm25_score: hit.bm25_score ?? null,
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
		source_chunk_ids: payload.source_chunk_ids ?? [],
		source_node_ids: payload.source_node_ids ?? [],
	});
}
