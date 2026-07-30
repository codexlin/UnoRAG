import "server-only";

import { z } from "zod";

import { RetrievalFiltersSchema } from "@/core/contracts";
import type { RetrievalResult } from "@/core/retrieval";
import type { AuthIdentity } from "@/lib/server/auth/provider";

import { DrizzleActiveGenerationResolver } from "./active-generation-resolver";
import { resolveAuthorizedRetrievalScope } from "./authorized-scope";
import { getTypeScriptRetrievalService } from "./runtime";

const ShadowInputSchema = z
	.object({
		query: z.string().trim().min(1),
		library_id: z.string().trim().min(1),
		top_k: z.number().int().min(1).max(50).default(6),
		filters: RetrievalFiltersSchema.optional(),
	})
	.strict();

export type RetrievalShadowExecution = {
	result: RetrievalResult | null;
	durationMs: number;
	error: string | null;
};

function isEnabled(): boolean {
	return (
		process.env.UNORAG_TS_RETRIEVAL_MODE?.trim().toLowerCase() === "shadow"
	);
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function startRetrievalShadow(input: {
	identity: AuthIdentity;
	payload: unknown;
}): Promise<RetrievalShadowExecution> | null {
	if (!isEnabled()) return null;
	const started = performance.now();
	return (async () => {
		try {
			const payload = ShadowInputSchema.parse(input.payload);
			const scope = await resolveAuthorizedRetrievalScope({
				identity: input.identity,
				libraryId: payload.library_id,
				resolver: new DrizzleActiveGenerationResolver(),
			});
			if (!scope) throw new Error("library is outside the authorized scope");
			const result = await getTypeScriptRetrievalService().retrieve({
				query: payload.query,
				libraryId: payload.library_id,
				scope,
				topK: payload.top_k,
				filters: payload.filters,
			});
			return {
				result,
				durationMs: performance.now() - started,
				error: null,
			};
		} catch (error) {
			return {
				result: null,
				durationMs: performance.now() - started,
				error: message(error),
			};
		}
	})();
}

function citationKey(value: unknown): string | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const citation = value as Record<string, unknown>;
	const id = citation.id;
	if (typeof id === "string" || typeof id === "number") return String(id);
	const documentId = citation.doc_id ?? citation.document_id;
	const chunkIndex = citation.chunk_index;
	if (
		(typeof documentId === "string" || typeof documentId === "number") &&
		(typeof chunkIndex === "string" || typeof chunkIndex === "number")
	) {
		return `${documentId}:${chunkIndex}`;
	}
	return null;
}

export async function observeRetrievalShadow(input: {
	execution: Promise<RetrievalShadowExecution> | null;
	pythonPayload: unknown;
	requestId: string;
}): Promise<void> {
	if (!input.execution) return;
	const execution = await input.execution;
	const python =
		input.pythonPayload &&
		typeof input.pythonPayload === "object" &&
		!Array.isArray(input.pythonPayload)
			? (input.pythonPayload as Record<string, unknown>)
			: {};
	const pythonKeys = new Set(
		(Array.isArray(python.citations) ? python.citations : [])
			.map(citationKey)
			.filter((value): value is string => value !== null),
	);
	const typescriptKeys = new Set(
		(execution.result?.citations ?? []).map((citation) => citation.id),
	);
	const overlap = [...typescriptKeys].filter((key) =>
		pythonKeys.has(key),
	).length;
	const denominator = Math.max(pythonKeys.size, typescriptKeys.size, 1);
	console.info(
		JSON.stringify({
			event: "retrieval.shadow.compare",
			request_id: input.requestId,
			ts_error: execution.error,
			ts_duration_ms: Math.round(execution.durationMs),
			python_count: pythonKeys.size,
			typescript_count: typescriptKeys.size,
			candidate_overlap_ratio: overlap / denominator,
			retrieval_mode: execution.result?.debug.retrievalMode ?? null,
			active_generation_count:
				execution.result?.debug.activeGenerationCount ?? null,
		}),
	);
}
