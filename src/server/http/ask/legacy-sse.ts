import {
	AiConcurrencyOverloadedError,
	AiConcurrencyWaitTimeoutError,
} from "@/core/ai";
import { projectRerankDiagnostic } from "@/core/retrieval/provider-request";

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
	"retrieval_debug",
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
	"figure_id",
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

export function projectPublicCitations(
	values: unknown[],
): Record<string, unknown>[] {
	return values
		.map(publicCitation)
		.filter((item): item is Record<string, unknown> => item !== null)
		.map((citation, index) => ({ ...citation, index: index + 1 }));
}

export function projectPublicRetrievalDebug(
	value: unknown,
): Record<string, unknown> {
	if (!isRecord(value)) return {};
	const result: Record<string, unknown> = {};
	const mappings = {
		trace_id: ["trace_id"],
		total_duration_ms: ["total_duration_ms"],
		query_type: ["query_type"],
		route_reason: ["route_reason"],
		top_score: ["top_score"],
		used_hybrid: ["used_hybrid", "usedHybrid"],
		hybrid_failed: ["hybrid_failed", "hybridFailed"],
		rerank_failed: ["rerank_failed", "rerankFailed"],
		retrieval_mode: ["retrieval_mode", "retrievalMode"],
		dense_hit_count: ["dense_hit_count", "denseHitCount"],
		active_generation_count: [
			"active_generation_count",
			"activeGenerationCount",
		],
		candidate_count_before_policy: [
			"candidate_count_before_policy",
			"candidateCountBeforePolicy",
		],
		evidence_threshold: ["evidence_threshold", "evidenceThreshold"],
		document_scope_status: [
			"document_scope_status",
			"documentConstraintStatus",
		],
		table_candidate_count: ["table_candidate_count"],
		judge_mode: ["judge_mode"],
		answer_granularity: ["answer_granularity"],
		judge_model: ["judge_model"],
		judge_provider: ["judge_provider"],
		judge_attempts: ["judge_attempts"],
		judge_duration_ms: ["judge_duration_ms"],
		judge_sufficiency_attempts: ["judge_sufficiency_attempts"],
		judge_sufficiency_duration_ms: ["judge_sufficiency_duration_ms"],
		judge_conflict_attempts: ["judge_conflict_attempts"],
		judge_conflict_duration_ms: ["judge_conflict_duration_ms"],
		judge_failed_stage: ["judge_failed_stage"],
		conflict_scope: ["conflict_scope"],
		conflict_candidate_count: ["conflict_candidate_count"],
		judge_timeout_ms: ["judge_timeout_ms"],
		judge_max_attempts: ["judge_max_attempts"],
		judge_budget_ms: ["judge_budget_ms"],
		judge_error_category: ["judge_error_category"],
		judge_status_code: ["judge_status_code"],
		judge_retryable: ["judge_retryable"],
		judge_input_tokens: ["judge_input_tokens"],
		judge_output_tokens: ["judge_output_tokens"],
		judge_total_tokens: ["judge_total_tokens"],
		retrieved_evidence_count: ["retrieved_evidence_count"],
		direct_evidence_count: ["direct_evidence_count"],
		lineage_evidence_count: ["lineage_evidence_count"],
		selected_evidence_count: ["selected_evidence_count"],
		comparison_context_count: ["comparison_context_count"],
		evidence_selection_mode: ["evidence_selection_mode"],
		evidence_selection_valid: ["evidence_selection_valid"],
		conflict_evidence_count: ["conflict_evidence_count"],
		evidence_resolution: ["evidence_resolution"],
	} as const;
	for (const [target, sources] of Object.entries(mappings)) {
		const source = sources.find((name) => value[name] !== undefined);
		if (source) result[target] = value[source];
	}
	const rerank = projectRerankDiagnostic(
		value.rerankDiagnostic ?? value.rerank_diagnostic,
	);
	if (rerank) result.rerank_diagnostic = rerank;
	if (Array.isArray(value.stages)) {
		result.stages = value.stages.flatMap((stage) => {
			if (!isRecord(stage)) return [];
			const name = stage.stage;
			const duration = stage.duration_ms;
			const rerank = projectRerankDiagnostic(
				isRecord(stage.detail) ? stage.detail.rerankDiagnostic : null,
			);
			if (typeof name !== "string" || typeof duration !== "number") return [];
			return [
				{
					stage: name,
					duration_ms: duration,
					ok: stage.ok !== false,
					...(rerank ? { rerank_diagnostic: rerank } : {}),
				},
			];
		});
	}
	return result;
}

export function encodeLegacySseEvent(
	event: LegacySseEventName,
	data: unknown,
): string {
	return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function terminalError(
	code:
		| "aborted"
		| "llm_overloaded"
		| "llm_queue_timeout"
		| "stream_failed"
		| "ask_access_changed",
): Record<string, unknown> {
	const message =
		code === "aborted"
			? "流式生成已取消"
			: code === "ask_access_changed"
				? "访问权限已变化，请重新发起提问"
				: code === "llm_overloaded"
					? "AI 服务繁忙，请稍后重试"
					: code === "llm_queue_timeout"
						? "AI 服务排队超时，请稍后重试"
						: "流式生成失败";
	return {
		message,
		code,
		truncated: true,
	};
}

export async function* streamLegacyAskSse(
	input: LegacyAskSseInput,
): AsyncGenerator<string> {
	const meta = project(input.meta, PUBLIC_META_KEYS);
	const citations = projectPublicCitations(input.citations);

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
		done.retrieval_debug = projectPublicRetrievalDebug(
			input.done.retrieval_debug,
		);
		done.answer = answer || String(done.answer ?? "");
		done.citations = citations;
		done.truncated = false;
		yield encodeLegacySseEvent("done", done);
	} catch (error) {
		const code = input.abortSignal?.aborted
			? "aborted"
			: error instanceof Error &&
					"code" in error &&
					error.code === "ask_access_changed"
				? "ask_access_changed"
				: error instanceof AiConcurrencyOverloadedError
					? "llm_overloaded"
					: error instanceof AiConcurrencyWaitTimeoutError
						? "llm_queue_timeout"
						: "stream_failed";
		yield encodeLegacySseEvent("error", terminalError(code));
	}
}
