export type ApiHealth = {
	status: string;
	service: string;
	env: string;
	ask_mode: string;
	effective_mode: string;
	graph: string;
	degraded: boolean;
	has_llm_key: boolean;
	qdrant_ok: boolean;
	reasons: string[];
	hybrid_enabled?: boolean;
	metadata_backend?: string;
};

export type ApiCitation = {
	id: string;
	index: number;
	title: string;
	page?: string | null;
	snippet: string;
	score: number;
};

export type ApiAskResponse = {
	session_id: string;
	question: string;
	answer: string;
	citations: ApiCitation[];
	mode: string;
	refused: boolean;
	refuse_reason?: string | null;
	retrieval_debug: Record<string, unknown>;
};

export type ApiLibrary = {
	id: string;
	name: string;
	status: "ready" | "indexing" | "empty" | string;
	doc_count: number;
	ready_count: number;
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
	error?: string | null;
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
	error?: string | null;
};

const DEFAULT_API_URL = "http://localhost:8000";

export function getApiBaseUrl() {
	return process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, "") || DEFAULT_API_URL;
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
	const response = await fetch(`${getApiBaseUrl()}/v1/libraries`, {
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
	const response = await fetch(
		`${getApiBaseUrl()}/v1/libraries/${encodeURIComponent(libraryId)}/documents`,
		{
			method: "GET",
			signal,
			cache: "no-store",
		},
	);
	if (!response.ok) {
		throw new Error(`documents ${response.status}`);
	}
	return (await response.json()) as ApiDocument[];
}

export async function createLibrary(input: {
	name: string;
	libraryId?: string;
}): Promise<ApiLibrary> {
	const response = await fetch(`${getApiBaseUrl()}/v1/libraries`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			name: input.name,
			library_id: input.libraryId,
		}),
	});
	if (!response.ok) {
		const text = await response.text();
		throw new Error(text || `create library ${response.status}`);
	}
	return (await response.json()) as ApiLibrary;
}

export async function uploadDocument(input: {
	libraryId: string;
	file: File;
}): Promise<ApiUploadResponse> {
	const form = new FormData();
	form.append("library_id", input.libraryId);
	form.append("file", input.file);
	const response = await fetch(`${getApiBaseUrl()}/v1/ingest/upload`, {
		method: "POST",
		body: form,
	});
	if (!response.ok) {
		const text = await response.text();
		throw new Error(text || `upload ${response.status}`);
	}
	return (await response.json()) as ApiUploadResponse;
}

export async function askQuestion(input: {
	question: string;
	libraryId?: string;
	sessionId?: string;
}): Promise<ApiAskResponse> {
	const response = await fetch(`${getApiBaseUrl()}/v1/ask`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			question: input.question,
			library_id: input.libraryId,
			session_id: input.sessionId,
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
		mode: string;
		refused: boolean;
		refuse_reason?: string | null;
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
		libraryId?: string;
		sessionId?: string;
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
