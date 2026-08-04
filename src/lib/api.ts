export type ApiHealth = {
	status: string;
	service: string;
	env: string;
	build_ref?: string;
	ask_mode: string;
	effective_mode: string;
	graph: string;
	degraded: boolean;
	has_llm_key: boolean;
	qdrant_ok: boolean;
	live_ready?: boolean;
	ask_ready?: boolean;
	reasons: string[];
	hybrid_enabled?: boolean;
	metadata_backend?: string;
	metadata_ok?: boolean;
};

export type ApiCitation = {
	id: string;
	index: number;
	title: string;
	page?: string | null;
	page_start?: number | null;
	page_end?: number | null;
	section_path?: string | null;
	preamble?: string | null;
	table_id?: string | null;
	figure_id?: string | null;
	snippet: string;
	/** Chunk body used in LLM context / drawer (no preamble). */
	text?: string;
	body?: string;
	score: number;
	dense_score?: number | null;
	bm25_score?: number | null;
	rrf_score?: number | null;
	used_rerank?: boolean;
	used_hybrid?: boolean;
	doc_id?: string | null;
	chunk_index?: number | null;
	filename?: string | null;
};

/** Timed stage entry inside retrieval_debug.stages */
export type ApiAskStage = {
	stage: string;
	duration_ms: number;
	ok: boolean;
	detail?: Record<string, unknown>;
};

/** Ask observability payload (P0 stages + summary fields). */
export type ApiRetrievalDebug = {
	trace_id?: string;
	question_hash?: string;
	library_id?: string | null;
	path?: string;
	route?: string;
	upgrade?: unknown;
	upgrade_reason?: string | null;
	downgrade_reason?: string | null;
	precise_gate?: string | null;
	refuse_reason?: string | null;
	total_duration_ms?: number;
	truncated?: boolean;
	stages?: ApiAskStage[];
	top_score?: number | null;
	used_hybrid?: boolean;
	hybrid_failed?: boolean;
	rerank_failed?: boolean;
	retrieval_mode?: string;
	[key: string]: unknown;
};

export type ApiArchiveTurn = {
	id: string;
	session_id: string;
	thread_id?: string | null;
	library_id?: string | null;
	question: string;
	answer: string;
	citations: ApiCitation[];
	mode: string;
	refused: boolean;
	refuse_reason?: string | null;
	created_at: string;
	retrieval_debug?: ApiRetrievalDebug | null;
};

export type ApiThread = {
	id: string;
	session_id?: string | null;
	library_id?: string | null;
	title: string;
	status: string;
	turn_count: number;
	created_at: string;
	updated_at: string;
};

export type ApiThreadDetail = ApiThread & {
	turns: ApiArchiveTurn[];
};

export type ApiAskResponse = {
	session_id: string;
	thread_id?: string | null;
	question: string;
	answer: string;
	citations: ApiCitation[];
	mode: string;
	refused: boolean;
	refuse_reason?: string | null;
	retrieval_debug: ApiRetrievalDebug;
	persisted?: boolean;
	persist_error?: string | null;
	hybrid_failed?: boolean;
	rerank_failed?: boolean;
	retrieval_mode?: string;
};

export type ApiLibrary = {
	id: string;
	name: string;
	description?: string | null;
	status: "ready" | "indexing" | "empty" | string;
	doc_count: number;
	ready_count: number;
	document_profile?: string;
	applied_document_profile?: string | null;
	scan_handling?: string;
	parse_preference?: string;
	ingest_policy_version?: number;
	requires_reindex?: boolean;
	created_at: string;
	updated_at: string;
};

export type ApiDocument = {
	id: string;
	library_id: string;
	name: string;
	filename: string;
	content_type: string;
	status: "processing" | "ready" | "failed" | string;
	chunk_count: number;
	size_bytes?: number | null;
	error?: string | null;
	storage_key?: string | null;
	has_file?: boolean;
	parser_report?: {
		partial?: boolean;
		failed_pages?: number[];
		needs_ocr_pages?: number[];
		warnings?: string[];
		notes?: string;
		parser?: string;
		backend?: string;
		[key: string]: unknown;
	} | null;
	parse_status?: {
		parser_label?: string | null;
		external_processing?: boolean | null;
		task_status?: string | null;
		degrade_reason?: string | null;
		parse_quality_hint?: string | null;
		provider_task_id?: string | null;
	} | null;
	parse_preference?: string | null;
	document_id?: string | null;
	document_version_id?: string | null;
	generation_id?: string | null;
	job_id?: string | null;
	job_status?: string | null;
	job_stage?: string | null;
	job_progress?: number | null;
	created_at: string;
	updated_at: string;
};

export type ApiUploadResponse = {
	library_id: string;
	doc_id: string;
	title: string;
	filename: string;
	chunk_count: number;
	status: string;
	mode: string;
	simulated: boolean;
	/** true when server accepted async ingest (HTTP 202) */
	accepted?: boolean;
	document_id?: string;
	document_version_id?: string;
	generation_id?: string;
	job_id?: string;
	error?: string | null;
	notice?: string | null;
	pipeline?: string | null;
	parser_report?: Record<string, unknown> | null;
};

export type ApiJob = {
	id: string;
	type: string;
	status: string;
	stage: string;
	progress: number;
	progress_current?: number | null;
	progress_total?: number | null;
	attempt: number;
	max_attempts: number;
	error_code?: string | null;
	error?: string | null;
	parser_report?: Record<string, unknown> | null;
	parse_status?: {
		parser_label?: string | null;
		external_processing?: boolean | null;
		task_status?: string | null;
		degrade_reason?: string | null;
		parse_quality_hint?: string | null;
		provider_task_id?: string | null;
	} | null;
	document_id: string;
	document_version_id: string;
	generation_id: string;
	library_id: string;
	created_at: string;
	started_at?: string | null;
	finished_at?: string | null;
	updated_at: string;
};

export function getApiBaseUrl() {
	return "/api/rag";
}

/** True when fetch was cancelled via AbortController (e.g. React Strict Mode remount). */
export function isAbortError(err: unknown): boolean {
	if (!err || typeof err !== "object") return false;
	const name = "name" in err ? String(err.name) : "";
	if (name === "AbortError") return true;
	if (err instanceof DOMException && err.code === DOMException.ABORT_ERR) {
		return true;
	}
	return false;
}

export function isApiAvailable(health: ApiHealth): boolean {
	return (
		health.status === "ok" && !health.degraded && health.ask_ready !== false
	);
}

export async function fetchHealth(signal?: AbortSignal): Promise<ApiHealth> {
	const response = await fetch(`${getApiBaseUrl()}/health`, {
		method: "GET",
		signal,
		cache: "no-store",
	});
	if (!response.ok) {
		throw new Error(`health ${response.status}`);
	}
	return (await response.json()) as ApiHealth;
}

export async function fetchLibraries(
	signal?: AbortSignal,
): Promise<ApiLibrary[]> {
	const response = await fetch("/api/libraries", {
		method: "GET",
		signal,
		cache: "no-store",
	});
	if (!response.ok) {
		throw new Error(`libraries ${response.status}`);
	}
	return (await response.json()) as ApiLibrary[];
}

export async function fetchDocuments(
	libraryId: string,
	signal?: AbortSignal,
): Promise<ApiDocument[]> {
	const encodedLibraryId = encodeURIComponent(libraryId);
	const controlResponse = await fetch(
		`/api/libraries/${encodedLibraryId}/documents`,
		{
			method: "GET",
			signal,
			cache: "no-store",
		},
	);
	if (!controlResponse.ok) {
		throw new Error(`documents ${controlResponse.status}`);
	}
	const controlDocuments = (await controlResponse.json()) as ApiDocument[];
	return controlDocuments.sort((left, right) =>
		right.updated_at.localeCompare(left.updated_at),
	);
}

export async function createLibrary(input: {
	name: string;
	description?: string;
	libraryId?: string;
	documentProfile?: string;
	scanHandling?: string;
	parsePreference?: string;
}): Promise<ApiLibrary> {
	const response = await fetch("/api/libraries", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			name: input.name,
			description: input.description?.trim() || null,
			library_id: input.libraryId,
			document_profile: input.documentProfile,
			scan_handling: input.scanHandling,
			parse_preference: input.parsePreference,
		}),
	});
	if (!response.ok) {
		const text = await response.text();
		throw new Error(parseApiError(text) || `create library ${response.status}`);
	}
	return (await response.json()) as ApiLibrary;
}

export async function updateLibrary(input: {
	libraryId: string;
	name?: string;
	description?: string | null;
	documentProfile?: string;
	scanHandling?: string;
	parsePreference?: string;
}): Promise<ApiLibrary> {
	const body: {
		name?: string;
		description?: string | null;
		document_profile?: string;
		scan_handling?: string;
		parse_preference?: string;
	} = {};
	if (input.name !== undefined) body.name = input.name;
	if (input.description !== undefined) {
		body.description =
			typeof input.description === "string"
				? input.description.trim() || null
				: null;
	}
	if (input.documentProfile !== undefined) {
		body.document_profile = input.documentProfile;
	}
	if (input.scanHandling !== undefined) {
		body.scan_handling = input.scanHandling;
	}
	if (input.parsePreference !== undefined) {
		body.parse_preference = input.parsePreference;
	}
	const response = await fetch(
		`/api/libraries/${encodeURIComponent(input.libraryId)}`,
		{
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		},
	);
	if (!response.ok) {
		const text = await response.text();
		throw new Error(parseApiError(text) || `update library ${response.status}`);
	}
	return (await response.json()) as ApiLibrary;
}

export async function deleteLibrary(libraryId: string): Promise<{
	ok: boolean;
	library_id: string;
	deleted_documents: number;
	delete_jobs_queued?: number;
	status?: string;
	accepted?: boolean;
	cleanup_queued?: boolean;
}> {
	const response = await fetch(
		`/api/libraries/${encodeURIComponent(libraryId)}`,
		{ method: "DELETE" },
	);
	if (!response.ok) {
		const text = await response.text();
		throw new Error(parseApiError(text) || `delete library ${response.status}`);
	}
	return (await response.json()) as {
		ok: boolean;
		library_id: string;
		deleted_documents: number;
	};
}

/** 上传文档；未传 displayName 时后端以文件名作为显示名。 */
export async function uploadDocument(input: {
	libraryId: string;
	file: File;
	/** 可选；前端默认不传，兼容旧调用 */
	displayName?: string;
}): Promise<ApiUploadResponse> {
	const form = new FormData();
	form.append("file", input.file);
	if (input.displayName?.trim()) {
		form.append("display_name", input.displayName.trim());
	}
	const response = await fetch(
		`/api/libraries/${encodeURIComponent(input.libraryId)}/documents`,
		{ method: "POST", body: form },
	);
	if (response.status !== 200 && response.status !== 202) {
		const text = await response.text();
		throw new Error(parseApiError(text) || `upload ${response.status}`);
	}
	return (await response.json()) as ApiUploadResponse;
}

export async function fetchJob(jobId: string): Promise<ApiJob> {
	const response = await fetch(`/api/jobs/${encodeURIComponent(jobId)}`, {
		cache: "no-store",
	});
	if (!response.ok) {
		const text = await response.text();
		throw new Error(parseApiError(text) || `job ${response.status}`);
	}
	return (await response.json()) as ApiJob;
}

export async function retryJob(jobId: string): Promise<ApiJob> {
	const response = await fetch(`/api/jobs/${encodeURIComponent(jobId)}/retry`, {
		method: "POST",
	});
	if (response.status !== 200 && response.status !== 202) {
		const text = await response.text();
		throw new Error(parseApiError(text) || `retry job ${response.status}`);
	}
	return (await response.json()) as ApiJob;
}

export async function cancelJob(jobId: string): Promise<ApiJob> {
	const response = await fetch(
		`/api/jobs/${encodeURIComponent(jobId)}/cancel`,
		{ method: "POST" },
	);
	if (response.status !== 200 && response.status !== 202) {
		const text = await response.text();
		throw new Error(parseApiError(text) || `cancel job ${response.status}`);
	}
	return (await response.json()) as ApiJob;
}

export async function deleteDocument(input: {
	libraryId: string;
	docId: string;
}): Promise<{
	ok: boolean;
	job_id: string;
	status: string;
	accepted?: boolean;
}> {
	const response = await fetch(
		`/api/libraries/${encodeURIComponent(input.libraryId)}/documents/${encodeURIComponent(input.docId)}`,
		{ method: "DELETE" },
	);
	if (response.status !== 200 && response.status !== 202) {
		const text = await response.text();
		throw new Error(parseApiError(text) || `delete ${response.status}`);
	}
	return (await response.json()) as {
		ok: boolean;
		job_id: string;
		status: string;
		accepted?: boolean;
	};
}

export type ApiDocumentVersion = {
	id: string;
	version: number;
	generation_id: string;
	status: string;
	is_active: boolean;
	is_desired: boolean;
	content_hash: string;
	size_bytes?: number | null;
	point_count?: number | null;
	chunk_count?: number | null;
	pipeline_version?: string | null;
	parser_backend?: string | null;
	failure_code?: string | null;
	error?: string | null;
	indexed_at?: string | null;
	activated_at?: string | null;
	superseded_at?: string | null;
	created_at: string;
	updated_at: string;
};

export async function fetchDocumentVersions(input: {
	libraryId: string;
	docId: string;
	signal?: AbortSignal;
}): Promise<{
	active_version_id: string | null;
	desired_version_id: string | null;
	versions: ApiDocumentVersion[];
}> {
	const response = await fetch(
		`/api/libraries/${encodeURIComponent(input.libraryId)}/documents/${encodeURIComponent(input.docId)}/versions`,
		{ method: "GET", cache: "no-store", signal: input.signal },
	);
	if (!response.ok) {
		const text = await response.text();
		throw new Error(parseApiError(text) || `versions ${response.status}`);
	}
	return (await response.json()) as {
		active_version_id: string | null;
		desired_version_id: string | null;
		versions: ApiDocumentVersion[];
	};
}

export async function reindexDocument(input: {
	libraryId: string;
	docId: string;
}): Promise<ApiUploadResponse> {
	const response = await fetch(
		`/api/libraries/${encodeURIComponent(input.libraryId)}/documents/${encodeURIComponent(input.docId)}/reindex`,
		{ method: "POST" },
	);
	if (response.status !== 200 && response.status !== 202) {
		const text = await response.text();
		throw new Error(parseApiError(text) || `reindex ${response.status}`);
	}
	return (await response.json()) as ApiUploadResponse;
}

export type ApiDocumentAclPrincipal = {
	id: string;
	label: string;
	email?: string | null;
	role?: string | null;
};

export type ApiDocumentAcl = {
	library_id: string;
	doc_id: string;
	document_id: string;
	scope: "workspace" | "restricted";
	principals: ApiDocumentAclPrincipal[];
	groups: ApiDocumentAclPrincipal[];
	principal_ids: string[];
	group_ids: string[];
	projection:
		| "none"
		| "projection_queued"
		| "deferred_to_ingest"
		| "reindex_required"
		| "control_plane_only";
	can_edit: boolean;
	projection_job_id?: string | null;
	ok?: boolean;
};

export async function fetchDocumentAcl(input: {
	libraryId: string;
	docId: string;
	signal?: AbortSignal;
}): Promise<ApiDocumentAcl> {
	const response = await fetch(
		`/api/libraries/${encodeURIComponent(input.libraryId)}/documents/${encodeURIComponent(input.docId)}/acl`,
		{ method: "GET", cache: "no-store", signal: input.signal },
	);
	if (!response.ok) {
		const text = await response.text();
		throw new Error(parseApiError(text) || `acl ${response.status}`);
	}
	return (await response.json()) as ApiDocumentAcl;
}

export async function updateDocumentAcl(input: {
	libraryId: string;
	docId: string;
	scope: "workspace" | "restricted";
	principalIds: string[];
	groupIds?: string[];
}): Promise<ApiDocumentAcl> {
	const response = await fetch(
		`/api/libraries/${encodeURIComponent(input.libraryId)}/documents/${encodeURIComponent(input.docId)}/acl`,
		{
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				scope: input.scope,
				principal_ids: input.principalIds,
				group_ids: input.groupIds ?? [],
			}),
		},
	);
	if (!response.ok) {
		const text = await response.text();
		throw new Error(parseApiError(text) || `acl update ${response.status}`);
	}
	return (await response.json()) as ApiDocumentAcl;
}

export type ApiWorkspaceMember = {
	userId: string;
	email: string | null;
	displayName: string;
	status: string;
	role: string;
};

export async function fetchWorkspaceMembers(signal?: AbortSignal): Promise<{
	members: ApiWorkspaceMember[];
	can_manage: boolean;
}> {
	const response = await fetch("/api/workspace/members", {
		method: "GET",
		cache: "no-store",
		signal,
	});
	if (!response.ok) {
		const text = await response.text();
		throw new Error(parseApiError(text) || `members ${response.status}`);
	}
	return (await response.json()) as {
		members: ApiWorkspaceMember[];
		can_manage: boolean;
	};
}

/** 用新文件创建文档新版本：保留旧 active generation，直到新 job 激活。 */
export async function replaceDocument(input: {
	libraryId: string;
	docId: string;
	file: File;
	displayName?: string;
}): Promise<ApiUploadResponse> {
	const form = new FormData();
	form.append("file", input.file);
	if (input.displayName?.trim()) {
		form.append("display_name", input.displayName.trim());
	}
	const response = await fetch(
		`/api/libraries/${encodeURIComponent(input.libraryId)}/documents/${encodeURIComponent(input.docId)}/versions`,
		{ method: "POST", body: form },
	);
	if (response.status !== 200 && response.status !== 202) {
		const text = await response.text();
		throw new Error(parseApiError(text) || `replace ${response.status}`);
	}
	return (await response.json()) as ApiUploadResponse;
}

export async function downloadDocument(
	docId: string,
	filename?: string,
): Promise<void> {
	const response = await fetch(
		`${getApiBaseUrl()}/v1/documents/${encodeURIComponent(docId)}/download`,
		{ method: "GET", cache: "no-store" },
	);
	if (!response.ok) {
		const text = await response.text();
		throw new Error(parseApiError(text) || `download ${response.status}`);
	}
	const blob = await response.blob();
	const disposition = response.headers.get("content-disposition");
	const fromHeader = disposition?.match(
		/filename\*?=(?:UTF-8''|")?([^";]+)/i,
	)?.[1];
	const resolvedName =
		filename || (fromHeader ? decodeURIComponent(fromHeader) : docId);
	const url = URL.createObjectURL(blob);
	try {
		const anchor = document.createElement("a");
		anchor.href = url;
		anchor.download = resolvedName;
		anchor.click();
	} finally {
		URL.revokeObjectURL(url);
	}
}

function parseApiError(text: string): string {
	const trimmed = text.trim();
	if (!trimmed) return "";
	try {
		const json = JSON.parse(trimmed) as { detail?: unknown };
		if (typeof json.detail === "string") return json.detail;
		if (json.detail && typeof json.detail === "object") {
			const detail = json.detail as { message?: string };
			if (typeof detail.message === "string") return detail.message;
			return JSON.stringify(json.detail);
		}
	} catch {
		/* plain text */
	}
	return trimmed;
}

export async function fetchArchive(input?: {
	libraryId?: string;
	sessionId?: string;
	threadId?: string;
	limit?: number;
	signal?: AbortSignal;
}): Promise<ApiArchiveTurn[]> {
	const params = new URLSearchParams();
	if (input?.libraryId) params.set("library_id", input.libraryId);
	if (input?.sessionId) params.set("session_id", input.sessionId);
	if (input?.threadId) params.set("thread_id", input.threadId);
	if (input?.limit) params.set("limit", String(input.limit));
	const query = params.toString();
	const response = await fetch(
		`${getApiBaseUrl()}/v1/archive${query ? `?${query}` : ""}`,
		{
			method: "GET",
			signal: input?.signal,
			cache: "no-store",
		},
	);
	if (!response.ok) {
		throw new Error(`archive ${response.status}`);
	}
	return (await response.json()) as ApiArchiveTurn[];
}

export async function fetchThreads(input?: {
	limit?: number;
	signal?: AbortSignal;
}): Promise<ApiThread[]> {
	const params = new URLSearchParams();
	if (input?.limit) params.set("limit", String(input.limit));
	const query = params.toString();
	const response = await fetch(
		`${getApiBaseUrl()}/v1/threads${query ? `?${query}` : ""}`,
		{
			method: "GET",
			signal: input?.signal,
			cache: "no-store",
		},
	);
	if (!response.ok) {
		throw new Error(`threads ${response.status}`);
	}
	return (await response.json()) as ApiThread[];
}

export async function fetchThread(
	threadId: string,
	signal?: AbortSignal,
): Promise<ApiThreadDetail> {
	const response = await fetch(`${getApiBaseUrl()}/v1/threads/${threadId}`, {
		method: "GET",
		signal,
		cache: "no-store",
	});
	if (!response.ok) {
		const text = await response.text();
		throw new Error(text || `thread ${response.status}`);
	}
	return (await response.json()) as ApiThreadDetail;
}

export async function archiveThread(input: {
	sessionId?: string;
	title?: string;
	libraryId?: string;
	turns: Array<{
		question: string;
		answer?: string;
		citations?: ApiCitation[];
		mode?: string;
		refused?: boolean;
		refuse_reason?: string | null;
		library_id?: string;
	}>;
}): Promise<ApiThreadDetail> {
	const response = await fetch(`${getApiBaseUrl()}/v1/threads`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			session_id: input.sessionId,
			title: input.title,
			library_id: input.libraryId,
			turns: input.turns,
		}),
	});
	if (!response.ok) {
		const text = await response.text();
		throw new Error(text || `archive thread ${response.status}`);
	}
	return (await response.json()) as ApiThreadDetail;
}

export async function continueThread(
	threadId: string,
	signal?: AbortSignal,
): Promise<ApiThreadDetail> {
	const response = await fetch(
		`${getApiBaseUrl()}/v1/threads/${threadId}/continue`,
		{
			method: "POST",
			signal,
		},
	);
	if (!response.ok) {
		const text = await response.text();
		throw new Error(text || `continue thread ${response.status}`);
	}
	return (await response.json()) as ApiThreadDetail;
}

export async function askQuestion(input: {
	question: string;
	libraryId: string;
	sessionId?: string;
	threadId?: string;
}): Promise<ApiAskResponse> {
	const response = await fetch(`${getApiBaseUrl()}/v1/ask`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			question: input.question,
			library_id: input.libraryId,
			session_id: input.sessionId,
			thread_id: input.threadId,
		}),
	});
	if (!response.ok) {
		const text = await response.text();
		throw new Error(text || `ask ${response.status}`);
	}
	return (await response.json()) as ApiAskResponse;
}

export type AskStreamHandlers = {
	onMeta?: (data: {
		session_id: string;
		thread_id?: string | null;
		mode: string;
		refused: boolean;
		refuse_reason?: string | null;
		hybrid_failed?: boolean;
		rerank_failed?: boolean;
		retrieval_mode?: string;
	}) => void;
	onCitations?: (citations: ApiCitation[]) => void;
	onToken?: (token: string) => void;
	onDone?: (data: ApiAskResponse) => void;
	onError?: (message: string) => void;
};

function parseSseChunk(buffer: string): {
	events: { event: string; data: string }[];
	rest: string;
} {
	const parts = buffer.split("\n\n");
	const rest = parts.pop() ?? "";
	const events: { event: string; data: string }[] = [];
	for (const part of parts) {
		if (!part.trim()) continue;
		let event = "message";
		const dataLines: string[] = [];
		for (const line of part.split("\n")) {
			if (line.startsWith("event:")) {
				event = line.slice(6).trim();
			} else if (line.startsWith("data:")) {
				dataLines.push(line.slice(5).trim());
			}
		}
		events.push({ event, data: dataLines.join("\n") });
	}
	return { events, rest };
}

export async function askQuestionStream(
	input: {
		question: string;
		libraryId: string;
		sessionId?: string;
		threadId?: string;
	},
	handlers: AskStreamHandlers,
	signal?: AbortSignal,
): Promise<void> {
	const response = await fetch(`${getApiBaseUrl()}/v1/ask/stream`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			accept: "text/event-stream",
		},
		body: JSON.stringify({
			question: input.question,
			library_id: input.libraryId,
			session_id: input.sessionId,
			thread_id: input.threadId,
		}),
		signal,
	});
	if (!response.ok || !response.body) {
		const text = await response.text();
		throw new Error(text || `ask stream ${response.status}`);
	}

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";

	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		const parsed = parseSseChunk(buffer);
		buffer = parsed.rest;
		for (const item of parsed.events) {
			let payload: unknown = item.data;
			try {
				payload = JSON.parse(item.data);
			} catch {
				// keep raw string
			}
			if (item.event === "meta") {
				handlers.onMeta?.(
					payload as Parameters<NonNullable<AskStreamHandlers["onMeta"]>>[0],
				);
			} else if (item.event === "citations") {
				handlers.onCitations?.(payload as ApiCitation[]);
			} else if (item.event === "token") {
				handlers.onToken?.(
					typeof payload === "string" ? payload : String(payload),
				);
			} else if (item.event === "done") {
				handlers.onDone?.(payload as ApiAskResponse);
			} else if (item.event === "error") {
				const message =
					typeof payload === "object" &&
					payload &&
					"message" in payload &&
					typeof (payload as { message: unknown }).message === "string"
						? (payload as { message: string }).message
						: "stream error";
				handlers.onError?.(message);
			}
		}
	}
}
