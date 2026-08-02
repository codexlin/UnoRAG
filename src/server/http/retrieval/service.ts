import "server-only";

import { z } from "zod";

import type { AuthorizedScope, RetrievalFilters } from "@/core/contracts";
import type {
	ActiveGenerationResolver,
	InternalCitation,
	RetrievalResult,
} from "@/core/retrieval";
import type { AuthIdentity } from "@/lib/server/auth/provider";
import { NativeAskPolicySchema } from "@/server/http/ask/policy";
import { DrizzleActiveGenerationResolver } from "@/server/retrieval/active-generation-resolver";
import { resolveAuthorizedRetrievalScope } from "@/server/retrieval/authorized-scope";
import { getTypeScriptRetrievalService } from "@/server/retrieval/runtime";

const NativeRetrievalRequestSchema = z
	.object({
		query: z.string().trim().min(1).max(4_000),
		library_id: z.string().trim().min(1).max(128),
		top_k: z.number().int().min(1).max(50).optional(),
		filters: z
			.object({
				record_type: z
					.enum([
						"chunk",
						"section",
						"document",
						"table",
						"table_summary",
						"chunk+table_summary",
						"text",
					])
					.optional(),
				doc_id: z.string().trim().min(1).max(128).optional(),
				table_id: z.string().trim().min(1).max(128).optional(),
				document_version_id: z.string().trim().min(1).max(128).optional(),
			})
			.strict()
			.optional(),
		ask_overrides: NativeAskPolicySchema.optional(),
	})
	.strict();

export type NativeRetrievalRequest = z.infer<
	typeof NativeRetrievalRequestSchema
>;

export type NativeRetrievalResponse = {
	query: string;
	library_id: string;
	citations: Record<string, unknown>[];
	refused: boolean;
	refuse_reason: "no_matching_evidence" | null;
	retrieval_mode: "dense" | "hybrid";
	retrieval_debug: Record<string, unknown>;
};

export interface NativeRetrievalEngine {
	retrieve(input: {
		query: string;
		libraryId: string;
		scope: AuthorizedScope;
		topK: number;
		filters?: RetrievalFilters;
		options?: {
			hybridEnabled?: boolean;
			rerankEnabled?: boolean;
		};
		signal?: AbortSignal;
	}): Promise<RetrievalResult>;
}

export type NativeRetrievalDependencies = {
	resolver: ActiveGenerationResolver;
	retrieval: NativeRetrievalEngine;
};

export class NativeRetrievalRequestError extends Error {
	constructor(
		readonly status: 400 | 404,
		message: string,
	) {
		super(message);
		this.name = "NativeRetrievalRequestError";
	}
}

const CITATION_KEYS = [
	"id",
	"index",
	"title",
	"snippet",
	"score",
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
	"document_version_id",
	"record_type",
	"record_id",
	"source_chunk_ids",
	"source_node_ids",
] as const satisfies readonly (keyof InternalCitation)[];

function projectCitation(citation: InternalCitation): Record<string, unknown> {
	const projected = Object.fromEntries(
		CITATION_KEYS.map((key) => [key, citation[key]]),
	);
	projected.document_id = citation.doc_id;
	return projected;
}

function projectDebug(
	result: RetrievalResult,
	requestId: string,
): Record<string, unknown> {
	return {
		trace_id: requestId,
		used_hybrid: result.debug.usedHybrid,
		hybrid_enabled: result.debug.hybridEnabled,
		hybrid_failed: result.debug.hybridFailed,
		rerank_failed: result.debug.rerankFailed,
		retrieval_mode: result.debug.retrievalMode,
		dense_hit_count: result.debug.denseHitCount,
		active_generation_count: result.debug.activeGenerationCount,
	};
}

function defaultDependencies(): NativeRetrievalDependencies {
	return {
		resolver: new DrizzleActiveGenerationResolver(),
		retrieval: getTypeScriptRetrievalService(),
	};
}

export async function executeNativeRetrieval(input: {
	identity: AuthIdentity;
	payload: unknown;
	requestId: string;
	signal?: AbortSignal;
	dependencies?: NativeRetrievalDependencies;
}): Promise<NativeRetrievalResponse> {
	const parsed = NativeRetrievalRequestSchema.safeParse(input.payload);
	if (!parsed.success) {
		throw new NativeRetrievalRequestError(400, "invalid retrieve request");
	}
	const payload = parsed.data;
	const policy = payload.ask_overrides ?? NativeAskPolicySchema.parse({});
	const dependencies = input.dependencies ?? defaultDependencies();
	const scope = await resolveAuthorizedRetrievalScope({
		identity: input.identity,
		libraryId: payload.library_id,
		resolver: dependencies.resolver,
	});
	if (!scope) {
		throw new NativeRetrievalRequestError(404, "library not found");
	}
	const result = await dependencies.retrieval.retrieve({
		query: payload.query,
		libraryId: payload.library_id,
		scope,
		topK: payload.top_k ?? policy.retrieve_top_k,
		filters: payload.filters,
		options: {
			hybridEnabled: policy.hybrid_enabled,
			rerankEnabled: policy.rerank_enabled,
		},
		signal: input.signal,
	});
	const citations = result.citations.map(projectCitation);
	const refused = citations.length === 0;
	return {
		query: payload.query,
		library_id: payload.library_id,
		citations,
		refused,
		refuse_reason: refused ? "no_matching_evidence" : null,
		retrieval_mode: result.debug.retrievalMode,
		retrieval_debug: projectDebug(result, input.requestId),
	};
}
