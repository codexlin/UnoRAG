import { isDashScopeEndpoint } from "@/core/ai/model-environment";
import {
	buildRerankRequestBody,
	resolveRerankEndpoint,
} from "@/core/retrieval/rerank/provider";
import type {
	ModelConnectionTestResult,
	ModelSlot,
} from "@/lib/model-settings";
import {
	assertSafeModelEndpointUrl,
	createSafeModelFetch,
	UnsafeModelEndpointError,
} from "@/lib/server/model-settings-url";

// Minimal valid 1x1 transparent PNG for multimodal vision endpoint verification.
const PROBE_PNG_DATA_URL =
	"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
const MAX_PROBE_RESPONSE_BYTES = 256 * 1024;

export type ModelProbeInput = {
	slot: ModelSlot;
	baseUrl: string;
	apiKey: string;
	model: string;
	timeoutMs?: number;
	fetch?: typeof globalThis.fetch;
};

type HttpProbeOutcome =
	| { ok: true; status: number; json: unknown; durationMs: number }
	| {
			ok: false;
			status: number | null;
			category: ModelConnectionTestResult["category"];
			durationMs: number;
	  };

function classifyStatus(status: number): ModelConnectionTestResult["category"] {
	if (status === 401 || status === 403) return "auth_error";
	if (status === 404 || status === 405) return "not_found";
	if (status === 429) return "rate_limited";
	return "http_error";
}

async function readBoundedJson(response: Response): Promise<unknown> {
	const contentLength = Number(response.headers.get("content-length") ?? "");
	if (
		Number.isFinite(contentLength) &&
		contentLength > MAX_PROBE_RESPONSE_BYTES
	) {
		void response.body?.cancel().catch(() => undefined);
		throw new Error("probe response body exceeded size limit");
	}
	if (!response.body) {
		const text = await response.text();
		if (Buffer.byteLength(text, "utf8") > MAX_PROBE_RESPONSE_BYTES) {
			throw new Error("probe response body exceeded size limit");
		}
		return JSON.parse(text);
	}
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let totalBytes = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			totalBytes += value.byteLength;
			if (totalBytes > MAX_PROBE_RESPONSE_BYTES) {
				await reader.cancel().catch(() => undefined);
				throw new Error("probe response body exceeded size limit");
			}
			chunks.push(value);
		}
		const merged = new Uint8Array(totalBytes);
		let offset = 0;
		for (const chunk of chunks) {
			merged.set(chunk, offset);
			offset += chunk.byteLength;
		}
		return JSON.parse(new TextDecoder().decode(merged));
	} finally {
		reader.releaseLock();
	}
}

async function postJsonProbe(input: {
	url: string;
	apiKey: string;
	body: Record<string, unknown>;
	deadlineMs: number;
	fetchImpl: typeof globalThis.fetch;
}): Promise<HttpProbeOutcome> {
	const startedAt = Date.now();
	const remainingMs = input.deadlineMs - startedAt;
	if (remainingMs <= 0) {
		return { ok: false, status: null, category: "timeout", durationMs: 0 };
	}
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), remainingMs);
	try {
		const response = await input.fetchImpl(input.url, {
			method: "POST",
			redirect: "error",
			headers: {
				authorization: `Bearer ${input.apiKey}`,
				"content-type": "application/json",
			},
			body: JSON.stringify(input.body),
			signal: controller.signal,
		});
		const durationMs = Math.max(0, Date.now() - startedAt);
		if (!response.ok) {
			void response.body?.cancel().catch(() => undefined);
			return {
				ok: false,
				status: response.status,
				category: classifyStatus(response.status),
				durationMs,
			};
		}
		try {
			const json = await readBoundedJson(response);
			return { ok: true, status: response.status, json, durationMs };
		} catch {
			return {
				ok: false,
				status: response.status,
				category: "invalid_response",
				durationMs,
			};
		}
	} catch (error) {
		const durationMs = Math.max(0, Date.now() - startedAt);
		if (error instanceof UnsafeModelEndpointError) {
			return {
				ok: false,
				status: null,
				category: "invalid_config",
				durationMs,
			};
		}
		if (controller.signal.aborted) {
			return { ok: false, status: null, category: "timeout", durationMs };
		}
		return { ok: false, status: null, category: "network_error", durationMs };
	} finally {
		clearTimeout(timer);
	}
}

function hasValidChatChoices(payload: unknown): boolean {
	if (!payload || typeof payload !== "object") return false;
	const choices = (payload as { choices?: unknown }).choices;
	return Array.isArray(choices) && choices.length > 0;
}

function hasReportedUsage(payload: unknown): boolean {
	if (!payload || typeof payload !== "object") return false;
	const usage = (payload as { usage?: unknown }).usage;
	if (!usage || typeof usage !== "object") return false;
	const record = usage as Record<string, unknown>;
	return (
		typeof record.total_tokens === "number" ||
		typeof record.prompt_tokens === "number"
	);
}

function detectRerankFormat(payload: unknown): "results" | "data" | null {
	if (!payload || typeof payload !== "object") return null;
	const record = payload as Record<string, unknown>;
	const validItems = (list: unknown): boolean =>
		Array.isArray(list) &&
		list.length > 0 &&
		list.every(
			(item) =>
				Boolean(item) &&
				typeof item === "object" &&
				typeof (item as { index?: unknown }).index === "number" &&
				typeof (item as { relevance_score?: unknown }).relevance_score ===
					"number",
		);
	const hasResults = validItems(record.results);
	const hasData = validItems(record.data);
	if (hasResults && !hasData) return "results";
	if (hasData && !hasResults) return "data";
	return null;
}

function failureDetail(
	slot: ModelSlot,
	category: ModelConnectionTestResult["category"],
	status: number | null,
): string {
	switch (category) {
		case "auth_error":
			return `${slot} endpoint rejected credentials (HTTP ${status ?? 401})`;
		case "not_found":
			return `${slot} endpoint or model not found (HTTP ${status ?? 404})`;
		case "rate_limited":
			return `${slot} endpoint rate-limited the probe (HTTP 429)`;
		case "timeout":
			return `${slot} endpoint timed out before responding`;
		case "network_error":
			return `${slot} endpoint could not be reached`;
		case "invalid_response":
			return `${slot} endpoint returned an incompatible response shape`;
		case "invalid_config":
			return `${slot} endpoint resolved to a blocked metadata or unspecified host`;
		default:
			return `${slot} endpoint failed (HTTP ${status ?? "unknown"})`;
	}
}

export async function probeModelConnection(
	input: ModelProbeInput,
): Promise<ModelConnectionTestResult> {
	const timeoutMs = input.timeoutMs ?? 10_000;
	const deadlineMs = Date.now() + timeoutMs;
	const fetchImpl = input.fetch
		? createSafeModelFetch({ fetch: input.fetch })
		: createSafeModelFetch();

	let safeBaseUrl: string;
	try {
		safeBaseUrl = assertSafeModelEndpointUrl(input.baseUrl, "base_url");
	} catch (error) {
		return {
			ok: false,
			slot: input.slot,
			duration_ms: 0,
			status_code: null,
			category: "invalid_config",
			resolved_endpoint: null,
			checks: {
				connectivity: false,
				structured_outputs: null,
				include_usage: null,
				rerank_format: null,
				vision: null,
			},
			suggestions: {},
			detail:
				error instanceof UnsafeModelEndpointError
					? error.message
					: "invalid endpoint URL",
		};
	}

	const model = input.model.trim();
	const apiKey = input.apiKey.trim();
	if (!model || !apiKey) {
		return {
			ok: false,
			slot: input.slot,
			duration_ms: 0,
			status_code: null,
			category: "invalid_config",
			resolved_endpoint: safeBaseUrl,
			checks: {
				connectivity: false,
				structured_outputs: null,
				include_usage: null,
				rerank_format: null,
				vision: null,
			},
			suggestions: {},
			detail: !model ? "model name is required" : "API key is required",
		};
	}

	if (input.slot === "rerank") {
		const primaryUrl = resolveRerankEndpoint(safeBaseUrl);
		const body = buildRerankRequestBody({
			baseUrl: safeBaseUrl,
			model,
			query: "UnoRAG connectivity check",
			documents: ["UnoRAG rerank endpoint verification passage."],
			topN: 1,
		});
		const first = await postJsonProbe({
			url: primaryUrl,
			apiKey,
			body,
			deadlineMs,
			fetchImpl,
		});
		if (first.ok) {
			const format = detectRerankFormat(first.json);
			if (!format) {
				return {
					ok: false,
					slot: "rerank",
					duration_ms: first.durationMs,
					status_code: first.status,
					category: "invalid_response",
					resolved_endpoint: primaryUrl,
					checks: {
						connectivity: true,
						structured_outputs: null,
						include_usage: null,
						rerank_format: null,
						vision: null,
					},
					suggestions: {},
					detail:
						"rerank response missing valid results[] or data[] with index and relevance_score",
				};
			}
			return {
				ok: true,
				slot: "rerank",
				duration_ms: first.durationMs,
				status_code: first.status,
				category: "ok",
				resolved_endpoint: primaryUrl,
				checks: {
					connectivity: true,
					structured_outputs: null,
					include_usage: null,
					rerank_format: format,
					vision: null,
				},
				suggestions: {},
				detail: `Rerank endpoint verified (${format} format).`,
			};
		}

		// When caller entered a base URL without /rerank(s) and /reranks returned 404/405,
		// probe singular /rerank (vLLM, SiliconFlow, Xinference, Jina, Cohere, Voyage).
		const autoAppendedPlural = !/\/reranks?$/i.test(safeBaseUrl);
		if (autoAppendedPlural && (first.status === 404 || first.status === 405)) {
			const singularUrl = `${safeBaseUrl}/rerank`;
			const second = await postJsonProbe({
				url: singularUrl,
				apiKey,
				body: buildRerankRequestBody({
					baseUrl: singularUrl,
					model,
					query: "UnoRAG connectivity check",
					documents: ["UnoRAG rerank endpoint verification passage."],
					topN: 1,
				}),
				deadlineMs,
				fetchImpl,
			});
			const totalDurationMs = first.durationMs + second.durationMs;
			if (second.ok) {
				const format = detectRerankFormat(second.json);
				if (format) {
					return {
						ok: true,
						slot: "rerank",
						duration_ms: totalDurationMs,
						status_code: second.status,
						category: "ok",
						resolved_endpoint: singularUrl,
						checks: {
							connectivity: true,
							structured_outputs: null,
							include_usage: null,
							rerank_format: format,
							vision: null,
						},
						suggestions: { base_url: singularUrl },
						detail: `Detected singular /rerank endpoint (${format} format); apply suggested URL.`,
					};
				}
				return {
					ok: false,
					slot: "rerank",
					duration_ms: totalDurationMs,
					status_code: second.status,
					category: "invalid_response",
					resolved_endpoint: singularUrl,
					checks: {
						connectivity: true,
						structured_outputs: null,
						include_usage: null,
						rerank_format: null,
						vision: null,
					},
					suggestions: {},
					detail:
						"rerank response missing valid results[] or data[] with index and relevance_score",
				};
			}
			// Surface actionable /rerank errors (401/400/429/timeout/network) instead of masking with /reranks 404.
			if (second.category !== "not_found") {
				return {
					ok: false,
					slot: "rerank",
					duration_ms: totalDurationMs,
					status_code: second.status,
					category: second.category,
					resolved_endpoint: singularUrl,
					checks: {
						connectivity: false,
						structured_outputs: null,
						include_usage: null,
						rerank_format: null,
						vision: null,
					},
					suggestions: {},
					detail: failureDetail("rerank", second.category, second.status),
				};
			}
			return {
				ok: false,
				slot: "rerank",
				duration_ms: totalDurationMs,
				status_code: second.status,
				category: second.category,
				resolved_endpoint: primaryUrl,
				checks: {
					connectivity: false,
					structured_outputs: null,
					include_usage: null,
					rerank_format: null,
					vision: null,
				},
				suggestions: {},
				detail: failureDetail("rerank", second.category, second.status),
			};
		}

		return {
			ok: false,
			slot: "rerank",
			duration_ms: first.durationMs,
			status_code: first.status,
			category: first.category,
			resolved_endpoint: primaryUrl,
			checks: {
				connectivity: false,
				structured_outputs: null,
				include_usage: null,
				rerank_format: null,
				vision: null,
			},
			suggestions: {},
			detail: failureDetail("rerank", first.category, first.status),
		};
	}

	const completionsUrl = `${safeBaseUrl}/chat/completions`;
	const dashscopeThinkingOff = isDashScopeEndpoint(safeBaseUrl)
		? { enable_thinking: false }
		: {};

	if (input.slot === "vlm") {
		const vision = await postJsonProbe({
			url: completionsUrl,
			apiKey,
			body: {
				model,
				max_tokens: 16,
				temperature: 0,
				...dashscopeThinkingOff,
				messages: [
					{
						role: "user",
						content: [
							{ type: "text", text: "Reply with ok." },
							{
								type: "image_url",
								image_url: { url: PROBE_PNG_DATA_URL },
							},
						],
					},
				],
			},
			deadlineMs,
			fetchImpl,
		});
		if (!vision.ok) {
			return {
				ok: false,
				slot: "vlm",
				duration_ms: vision.durationMs,
				status_code: vision.status,
				category: vision.category,
				resolved_endpoint: completionsUrl,
				checks: {
					connectivity: false,
					structured_outputs: null,
					include_usage: null,
					rerank_format: null,
					vision: false,
				},
				suggestions: {},
				detail: failureDetail("vlm", vision.category, vision.status),
			};
		}
		if (!hasValidChatChoices(vision.json)) {
			return {
				ok: false,
				slot: "vlm",
				duration_ms: vision.durationMs,
				status_code: vision.status,
				category: "invalid_response",
				resolved_endpoint: completionsUrl,
				checks: {
					connectivity: true,
					structured_outputs: null,
					include_usage: null,
					rerank_format: null,
					vision: false,
				},
				suggestions: {},
				detail: "VLM response missing valid choices[]",
			};
		}
		return {
			ok: true,
			slot: "vlm",
			duration_ms: vision.durationMs,
			status_code: vision.status,
			category: "ok",
			resolved_endpoint: completionsUrl,
			checks: {
				connectivity: true,
				structured_outputs: null,
				include_usage: hasReportedUsage(vision.json),
				rerank_format: null,
				vision: true,
			},
			suggestions: {},
			detail: "Multimodal vision endpoint verified.",
		};
	}

	// Chat / Judge slot: Step 1 connectivity + usage, Step 2 json_schema structured output probe.
	const basic = await postJsonProbe({
		url: completionsUrl,
		apiKey,
		body: {
			model,
			max_tokens: 16,
			temperature: 0,
			...dashscopeThinkingOff,
			messages: [{ role: "user", content: "Reply with ok." }],
		},
		deadlineMs,
		fetchImpl,
	});
	if (!basic.ok) {
		return {
			ok: false,
			slot: input.slot,
			duration_ms: basic.durationMs,
			status_code: basic.status,
			category: basic.category,
			resolved_endpoint: completionsUrl,
			checks: {
				connectivity: false,
				structured_outputs: null,
				include_usage: null,
				rerank_format: null,
				vision: null,
			},
			suggestions: {},
			detail: failureDetail(input.slot, basic.category, basic.status),
		};
	}
	if (!hasValidChatChoices(basic.json)) {
		return {
			ok: false,
			slot: input.slot,
			duration_ms: basic.durationMs,
			status_code: basic.status,
			category: "invalid_response",
			resolved_endpoint: completionsUrl,
			checks: {
				connectivity: true,
				structured_outputs: null,
				include_usage: null,
				rerank_format: null,
				vision: null,
			},
			suggestions: {},
			detail: `${input.slot} response missing valid choices[]`,
		};
	}

	const usageSupported = hasReportedUsage(basic.json);
	const structured = await postJsonProbe({
		url: completionsUrl,
		apiKey,
		body: {
			model,
			max_tokens: 32,
			temperature: 0,
			...dashscopeThinkingOff,
			messages: [
				{
					role: "user",
					content: 'Return JSON {"ok": true}.',
				},
			],
			response_format: {
				type: "json_schema",
				json_schema: {
					name: "unorag_connectivity_probe",
					strict: true,
					schema: {
						type: "object",
						properties: { ok: { type: "boolean" } },
						required: ["ok"],
						additionalProperties: false,
					},
				},
			},
		},
		deadlineMs,
		fetchImpl,
	});
	const structuredSupported =
		structured.ok && hasValidChatChoices(structured.json);
	const suggestions: ModelConnectionTestResult["suggestions"] = {};
	if (!structuredSupported) {
		suggestions.supports_structured_outputs = false;
	}
	if (!usageSupported && input.slot === "chat") {
		suggestions.include_usage = false;
	}

	return {
		ok: true,
		slot: input.slot,
		duration_ms: basic.durationMs + structured.durationMs,
		status_code: basic.status,
		category: "ok",
		resolved_endpoint: completionsUrl,
		checks: {
			connectivity: true,
			structured_outputs: structuredSupported,
			include_usage: usageSupported,
			rerank_format: null,
			vision: null,
		},
		suggestions,
		detail: structuredSupported
			? "Endpoint verified (json_schema structured outputs supported)."
			: "Endpoint reachable, but json_schema structured outputs failed; disable structured outputs for this slot.",
	};
}
