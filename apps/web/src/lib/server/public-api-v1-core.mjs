export const PUBLIC_API_V1 = "1";
/** Body marker for success responses; header uses PUBLIC_API_V1 ("1"). */
export const PUBLIC_API_VERSION_BODY = "v1";
export const PUBLIC_API_MAX_BODY_BYTES = 64 * 1024;
export const PUBLIC_API_UPSTREAM_TIMEOUT_MS = 60_000;

/** Stable success top-level keys (excluding dynamic values). */
export const PUBLIC_RETRIEVE_SUCCESS_KEYS = Object.freeze([
	"api_version",
	"trace_id",
	"query",
	"library_id",
	"citations",
	"refused",
	"refuse_reason",
	"retrieval_mode",
]);
export const PUBLIC_ASK_SUCCESS_KEYS = Object.freeze([
	"api_version",
	"trace_id",
	"session_id",
	"question",
	"answer",
	"citations",
	"refused",
	"refuse_reason",
	"retrieval_mode",
]);
export const PUBLIC_CITATION_KEYS = Object.freeze([
	"id",
	"index",
	"title",
	"snippet",
	"score",
	"document_id",
	"filename",
	"page",
	"page_start",
	"page_end",
	"section_path",
	"table_id",
	"row_start",
	"row_end",
	"record_type",
]);

const ASK_FIELDS = new Set(["question", "library_id", "session_id"]);
const RETRIEVE_FIELDS = new Set([
	"query",
	"question",
	"library_id",
	"top_k",
	"filters",
]);
const RETRIEVE_FILTER_FIELDS = new Set([
	"record_type",
	"doc_id",
	"table_id",
	"document_version_id",
]);

function isObject(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invalid(message, details) {
	return {
		ok: false,
		status: 400,
		code: "invalid_request",
		message,
		...(details ? { details } : {}),
	};
}

function requiredString(payload, field, maxLength) {
	const value = payload[field];
	if (typeof value !== "string" || !value.trim()) {
		return invalid(`${field} is required`, { field });
	}
	const normalized = value.trim();
	if (normalized.length > maxLength) {
		return invalid(`${field} must not exceed ${maxLength} characters`, {
			field,
			max_length: maxLength,
		});
	}
	return { ok: true, value: normalized };
}

function rejectUnknownFields(payload, allowed) {
	const fields = Object.keys(payload)
		.filter((field) => !allowed.has(field))
		.sort();
	if (!fields.length) return null;
	return invalid("request contains unsupported fields", { fields });
}

function normalizeFilters(value) {
	if (value === undefined) {
		return { ok: true, value: undefined };
	}
	if (!isObject(value)) {
		return invalid("filters must be a JSON object", { field: "filters" });
	}
	const unknown = rejectUnknownFields(value, RETRIEVE_FILTER_FIELDS);
	if (unknown) {
		return invalid("filters contains unsupported fields", {
			fields: unknown.details.fields,
		});
	}
	const normalized = {};
	for (const field of RETRIEVE_FILTER_FIELDS) {
		if (!(field in value)) continue;
		if (typeof value[field] !== "string" || !value[field].trim()) {
			return invalid(`filters.${field} must be a non-empty string`, {
				field: `filters.${field}`,
			});
		}
		const item = value[field].trim();
		if (item.length > 128) {
			return invalid(`filters.${field} must not exceed 128 characters`, {
				field: `filters.${field}`,
				max_length: 128,
			});
		}
		normalized[field] = item;
	}
	return {
		ok: true,
		value: Object.keys(normalized).length ? normalized : undefined,
	};
}

export function normalizePublicApiRequest(target, value) {
	if (!isObject(value)) {
		return invalid("JSON body must be an object");
	}
	const allowed = target === "ask" ? ASK_FIELDS : RETRIEVE_FIELDS;
	const unknown = rejectUnknownFields(value, allowed);
	if (unknown) return unknown;

	const library = requiredString(value, "library_id", 128);
	if (!library.ok) return library;

	if (target === "ask") {
		const question = requiredString(value, "question", 4000);
		if (!question.ok) return question;
		const payload = {
			question: question.value,
			library_id: library.value,
		};
		if (value.session_id !== undefined) {
			if (typeof value.session_id !== "string" || !value.session_id.trim()) {
				return invalid("session_id must be a non-empty string", {
					field: "session_id",
				});
			}
			const sessionId = value.session_id.trim();
			if (sessionId.length > 256) {
				return invalid("session_id must not exceed 256 characters", {
					field: "session_id",
					max_length: 256,
				});
			}
			payload.session_id = sessionId;
		}
		return { ok: true, payload };
	}

	if (value.query !== undefined && value.question !== undefined) {
		return invalid("query and question cannot be used together", {
			fields: ["query", "question"],
		});
	}
	const querySource = {
		query: value.query !== undefined ? value.query : value.question,
	};
	const query = requiredString(querySource, "query", 4000);
	if (!query.ok) {
		return invalid("query is required", { field: "query" });
	}
	const payload = {
		query: query.value,
		library_id: library.value,
	};
	if (value.top_k !== undefined) {
		if (!Number.isInteger(value.top_k) || value.top_k < 1 || value.top_k > 50) {
			return invalid("top_k must be an integer between 1 and 50", {
				field: "top_k",
				minimum: 1,
				maximum: 50,
			});
		}
		payload.top_k = value.top_k;
	}
	const filters = normalizeFilters(value.filters);
	if (!filters.ok) return filters;
	if (filters.value) payload.filters = filters.value;
	return { ok: true, payload };
}

export function publicApiErrorPayload({
	code,
	message,
	requestId,
	retryable = false,
	details,
}) {
	return {
		error: {
			code,
			message,
			request_id: requestId,
			retryable,
			...(details ? { details } : {}),
		},
	};
}

export function normalizeUpstreamError(status, payload) {
	if (status === 400 || status === 422) {
		return {
			status: 400,
			code: "invalid_request",
			message: upstreamErrorMessage(
				payload,
				"Knowledge API request is invalid",
			),
			retryable: false,
		};
	}
	switch (status) {
		case 413:
			return {
				status,
				code: "payload_too_large",
				message: "Knowledge API request body is too large",
				retryable: false,
			};
		case 415:
			return {
				status,
				code: "unsupported_media_type",
				message: "Knowledge API request media type is unsupported",
				retryable: false,
			};
		case 429:
			return {
				status,
				code: "rate_limit_exceeded",
				message: "Knowledge API rate limit exceeded",
				retryable: true,
			};
		case 503:
			return {
				status,
				code: "service_unavailable",
				message: "Knowledge service is temporarily unavailable",
				retryable: true,
			};
		case 504:
			return {
				status,
				code: "upstream_timeout",
				message: "Knowledge API request timed out",
				retryable: true,
			};
		default:
			return {
				status: 502,
				code: "upstream_unavailable",
				message: "RAG data plane unavailable",
				retryable: true,
			};
	}
}

export function upstreamErrorMessage(payload, fallback) {
	if (!isObject(payload)) return fallback;
	if (typeof payload.detail === "string" && payload.detail.trim()) {
		return payload.detail.trim();
	}
	if (
		isObject(payload.detail) &&
		typeof payload.detail.message === "string" &&
		payload.detail.message.trim()
	) {
		return payload.detail.message.trim();
	}
	if (typeof payload.message === "string" && payload.message.trim()) {
		return payload.message.trim();
	}
	return fallback;
}

function optionalString(value) {
	return typeof value === "string" && value.trim() ? value : null;
}

function stringValue(value) {
	return typeof value === "string" ? value : null;
}

function optionalInteger(value) {
	return Number.isInteger(value) ? value : null;
}

function optionalNumber(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function publicCitation(value) {
	if (!isObject(value)) return null;
	const id = stringValue(value.id);
	const title = stringValue(value.title);
	const snippet = stringValue(value.snippet);
	const score = optionalNumber(value.score);
	if (id === null || title === null || snippet === null || score === null) {
		return null;
	}
	return {
		id,
		index: optionalInteger(value.index) ?? 0,
		title,
		snippet,
		score,
		document_id: optionalString(value.doc_id),
		filename: optionalString(value.filename),
		page: optionalString(value.page),
		page_start: optionalInteger(value.page_start),
		page_end: optionalInteger(value.page_end),
		section_path: optionalString(value.section_path),
		table_id: optionalString(value.table_id),
		row_start: optionalInteger(value.row_start),
		row_end: optionalInteger(value.row_end),
		record_type: optionalString(value.record_type),
	};
}

function publicCitations(value) {
	if (!Array.isArray(value)) return null;
	const citations = value.map(publicCitation);
	if (citations.some((citation) => citation === null)) return null;
	return citations;
}

export function projectPublicApiSuccess(target, value, requestId) {
	if (!isObject(value)) return null;
	const citations = publicCitations(value.citations);
	if (citations === null) return null;
	const base = {
		api_version: PUBLIC_API_VERSION_BODY,
		trace_id: requestId,
		citations,
		refused: value.refused === true,
		refuse_reason: optionalString(value.refuse_reason),
		retrieval_mode: optionalString(value.retrieval_mode) ?? "dense",
	};
	if (target === "retrieve") {
		const query = optionalString(value.query);
		const libraryId = optionalString(value.library_id);
		if (!query || !libraryId) return null;
		return {
			api_version: base.api_version,
			trace_id: base.trace_id,
			query,
			library_id: libraryId,
			citations: base.citations,
			refused: base.refused,
			refuse_reason: base.refuse_reason,
			retrieval_mode: base.retrieval_mode,
		};
	}
	const sessionId = optionalString(value.session_id);
	const question = optionalString(value.question);
	if (!sessionId || !question || typeof value.answer !== "string") return null;
	return {
		api_version: base.api_version,
		trace_id: base.trace_id,
		session_id: sessionId,
		question,
		answer: value.answer,
		citations: base.citations,
		refused: base.refused,
		refuse_reason: base.refuse_reason,
		retrieval_mode: base.retrieval_mode,
	};
}

export function publicSuccessKeySet(target) {
	return target === "ask"
		? PUBLIC_ASK_SUCCESS_KEYS
		: PUBLIC_RETRIEVE_SUCCESS_KEYS;
}
