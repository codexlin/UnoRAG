export type ApiHealth = {
	status: string;
	service: string;
	env: string;
	ask_mode: string;
	graph: string;
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
	retrieval_debug: Record<string, unknown>;
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
