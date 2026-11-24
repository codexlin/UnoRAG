import type { ErrorGuidance } from "@/lib/error-diagnostics";

const ENGLISH_GUIDANCE: Record<string, readonly [string, string, string]> = {
	judge_unavailable: [
		"Evidence checks did not complete",
		"Evidence sufficiency, conflict, or source validation did not complete. No answer was generated.",
		"Use the request ID to check the failing stage and completed calls. Distinguish model requests from local validation.",
	],
	answer_citation_invalid: [
		"Answer citation validation failed",
		"The model cited a source number that does not exist or used an unsupported citation list or range.",
		"Use the request ID to review retrieval and generation. Check whether the model used table row numbers as source numbers, then retry.",
	],
	job_cancelled: [
		"Job cancelled",
		"The job received a cancellation request and stopped at a safe checkpoint.",
		"If the document still needs processing, start a new job from its details.",
	],
	document_ingest_empty: [
		"No indexable content",
		"The parser returned no content. Scans without a text layer and empty files can cause this.",
		"Check that the original is readable. Try MinerU or OCR and reindex.",
	],
	document_parse_invalid: [
		"Invalid document format",
		"The file contents or encoding did not match a supported format.",
		"Check the file and its extension, then export it to a supported format and upload it again.",
	],
	embedding_dimension_mismatch: [
		"Embedding dimension mismatch",
		"The embedding model output dimension differs from the Qdrant collection configuration.",
		"Check the model and dimension settings. If you change the model, rebuild in a new index generation.",
	],
	request_aborted: [
		"Request aborted",
		"The browser, proxy, or caller closed the connection before the answer was complete.",
		"Check client and proxy read timeouts, then ask again.",
	],
	stream_incomplete: [
		"Incomplete answer stream",
		"The SSE stream disconnected before the final event was sent.",
		"Use the request ID to check gateway and model provider logs and verify streaming timeouts.",
	],
	conversation_persist_failed: [
		"Conversation could not be saved",
		"The answer was delivered, but PostgreSQL could not save the conversation or message.",
		"Use the request ID to check database connectivity, transaction conflicts, and capacity. Ask again after recovery.",
	],
	llm_overloaded: [
		"Model concurrency limit reached",
		"The model provider has no free request slots.",
		"Retry later or adjust concurrency limits and provider capacity.",
	],
	llm_queue_timeout: [
		"Model queue timed out",
		"The request waited for a model slot longer than the configured limit.",
		"Check traffic spikes, concurrency limits, and provider latency. Increase capacity or enable a fallback model if needed.",
	],
	qdrant_error: [
		"Vector database error",
		"A Qdrant operation failed during retrieval or indexing.",
		"Check Qdrant health, disk, collection configuration, and network connectivity, then retry.",
	],
	document_delete_qdrant_failed: [
		"Vector cleanup failed",
		"The deletion job could not remove the document vectors after retrying.",
		"Confirm Qdrant is healthy and the collection is writable, then select Retry cleanup.",
	],
	document_delete_storage_failed: [
		"Source file cleanup failed",
		"The deletion job could not remove the original file from object storage after retrying.",
		"Check storage credentials, bucket permissions, and network connectivity, then select Retry cleanup.",
	],
	provider_parse_failed: [
		"Document parsing failed",
		"The parser provider could not return usable structured content.",
		"Check the file, parser health, and credentials. Try MinerU for complex or scanned PDFs and reindex.",
	],
	parser_budget_exhausted: [
		"Parsing budget exhausted",
		"The parser exceeded the total budget and automatic resubmission stopped.",
		"Use the job or workflow ID to check the queue, provider task, and timings. Confirm the external task has stopped before retrying.",
	],
};

export function englishOperationsGuidance(code: string | null): ErrorGuidance {
	const normalized = code?.trim().toLowerCase() ?? "";
	const exact = ENGLISH_GUIDANCE[normalized];
	if (exact) {
		const [title, cause, recovery] = exact;
		return { title, cause, recovery };
	}
	if (normalized.includes("mineru") || normalized.includes("parser")) {
		return {
			title: "Document parser error",
			cause:
				"The parser provider rejected the request, timed out, or returned an unusable result.",
			recovery:
				"Check parser health, credentials, file quality, and the provider response before reindexing.",
		};
	}
	if (normalized.includes("embedding")) {
		return {
			title: "Embedding error",
			cause: "The embedding request or response validation failed.",
			recovery:
				"Check model credentials, rate limits, dimensions, and network connectivity before retrying.",
		};
	}
	if (normalized.includes("timeout")) {
		return {
			title: "Execution timed out",
			cause: "A stage exceeded the system or provider time limit.",
			recovery:
				"Check provider latency, file size, and proxy timeouts for the failing stage before retrying.",
		};
	}
	return {
		title: "Unclassified runtime error",
		cause: "An error code and related identifiers were recorded.",
		recovery:
			"Look up the request or workflow ID in structured logs and verify dependency health before retrying.",
	};
}
