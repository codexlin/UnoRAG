const PUBLIC_META_KEYS = [
	"session_id",
	"thread_id",
	"mode",
	"refused",
	"refuse_reason",
	"trace_id",
	"hybrid_failed",
	"rerank_failed",
	"retrieval_mode",
] as const;

const PUBLIC_DONE_KEYS = [
	"session_id",
	"thread_id",
	"question",
	"answer",
	"mode",
	"refused",
	"refuse_reason",
	"trace_id",
	"persisted",
	"persist_error",
	"hybrid_failed",
	"rerank_failed",
	"retrieval_mode",
] as const;

const PUBLIC_CITATION_KEYS = [
	"id",
	"index",
	"title",
	"snippet",
	"score",
	"document_id",
	"doc_id",
	"filename",
	"page",
	"page_start",
	"page_end",
	"section_path",
	"preamble",
	"table_id",
	"row_start",
	"row_end",
	"headers",
	"rows",
	"text",
	"body",
	"dense_score",
	"bm25_score",
	"rrf_score",
	"used_rerank",
	"used_hybrid",
	"chunk_index",
	"filename",
	"document_version_id",
	"record_type",
	"record_id",
	"source_chunk_ids",
	"source_node_ids",
] as const;

export type LegacySseEventName =
	| "meta"
	| "citations"
	| "token"
	| "done"
	| "error";

export interface LegacyAskSseInput {
	meta: Record<string, unknown>;
	citations: unknown[];
	tokens: AsyncIterable<string>;
	done: Record<string, unknown>;
	abortSignal?: AbortSignal;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function project(
	value: Record<string, unknown>,
	keys: readonly string[],
): Record<string, unknown> {
	const projected: Record<string, unknown> = {};
	for (const key of keys) {
		if (value[key] !== undefined) projected[key] = value[key];
	}
	return projected;
}

function publicCitation(value: unknown): Record<string, unknown> | null {
	if (!isRecord(value)) return null;
	const citation = project(value, PUBLIC_CITATION_KEYS);
	if (citation.document_id === undefined && citation.doc_id !== undefined) {
		citation.document_id = citation.doc_id;
	}
	return citation;
}

export function encodeLegacySseEvent(
	event: LegacySseEventName,
	data: unknown,
): string {
	return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function terminalError(
	code: "aborted" | "stream_failed",
): Record<string, unknown> {
	return {
		message: code === "aborted" ? "流式生成已取消" : "流式生成失败",
		code,
		truncated: true,
	};
}

export async function* streamLegacyAskSse(
	input: LegacyAskSseInput,
): AsyncGenerator<string> {
	const meta = project(input.meta, PUBLIC_META_KEYS);
	const citations = input.citations
		.map(publicCitation)
		.filter((item): item is Record<string, unknown> => item !== null);

	yield encodeLegacySseEvent("meta", meta);
	yield encodeLegacySseEvent("citations", citations);

	let answer = "";
	try {
		if (input.abortSignal?.aborted) {
			yield encodeLegacySseEvent("error", terminalError("aborted"));
			return;
		}
		for await (const token of input.tokens) {
			if (input.abortSignal?.aborted) {
				yield encodeLegacySseEvent("error", terminalError("aborted"));
				return;
			}
			if (!token) continue;
			answer += token;
			yield encodeLegacySseEvent("token", token);
		}
		if (input.abortSignal?.aborted) {
			yield encodeLegacySseEvent("error", terminalError("aborted"));
			return;
		}
		const done = project(input.done, PUBLIC_DONE_KEYS);
		done.answer = answer || String(done.answer ?? "");
		done.citations = citations;
		done.truncated = false;
		yield encodeLegacySseEvent("done", done);
	} catch {
		yield encodeLegacySseEvent(
			"error",
			terminalError(input.abortSignal?.aborted ? "aborted" : "stream_failed"),
		);
	}
}
