import "server-only";

import { z } from "zod";

import type { AuthorizedScope, RetrievalFilters } from "@/core/contracts";
import type {
	ActiveGenerationResolver,
	InternalCitation,
	RerankProvider,
	RetrievalResult,
} from "@/core/retrieval";
import { projectRerankDiagnostic } from "@/core/retrieval/provider-request";
import type { AuthIdentity } from "@/lib/server/auth/provider";
import { findAuthorizedLibrary } from "@/lib/server/library-access";
import { resolveEffectiveOrganizationRerankRuntime } from "@/lib/server/organization-model-settings";
import {
	DrizzleHistoricalCitationAuthorizer,
	type HistoricalCitationAuthorizer,
} from "@/server/http/ask/conversation-handler";
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
						"figure",
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
			rerankerOverride?: RerankProvider | null;
			rerankCacheTag?: string;
		};
		signal?: AbortSignal;
	}): Promise<RetrievalResult>;
}

export type NativeRetrievalDependencies = {
	resolver: ActiveGenerationResolver;
	retrieval: NativeRetrievalEngine;
	resolveLibrary?: typeof findAuthorizedLibrary;
	citationAuthorizer?: HistoricalCitationAuthorizer;
};

export class NativeRetrievalRequestError extends Error {
	constructor(
		readonly status: 400 | 401 | 403 | 404,
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
	const rerank = projectRerankDiagnostic(result.debug.rerankDiagnostic);
	return {
		trace_id: requestId,
		used_hybrid: result.debug.usedHybrid,
		hybrid_enabled: result.debug.hybridEnabled,
		hybrid_failed: result.debug.hybridFailed,
		rerank_failed: result.debug.rerankFailed,
		...(rerank ? { rerank_diagnostic: rerank } : {}),
		retrieval_mode: result.debug.retrievalMode,
		dense_hit_count: result.debug.denseHitCount,
		active_generation_count: result.debug.activeGenerationCount,
	};
}

function identityScope(identity: AuthIdentity): string {
	return JSON.stringify([
		identity.tenantId,
		identity.workspaceId,
		identity.principalId,
		identity.role,
		identity.organizationRole,
		[...new Set(identity.groupIds)].sort(),
		identity.mustChangePassword,
	]);
}

function defaultDependencies(): NativeRetrievalDependencies {
	return {
		resolver: new DrizzleActiveGenerationResolver(),
		retrieval: getTypeScriptRetrievalService(),
		resolveLibrary: findAuthorizedLibrary,
		citationAuthorizer: new DrizzleHistoricalCitationAuthorizer(),
	};
}

export async function executeNativeRetrieval(input: {
	identity: AuthIdentity;
	payload: unknown;
	requestId: string;
	signal?: AbortSignal;
	dependencies?: NativeRetrievalDependencies;
	refreshIdentity?: () => Promise<AuthIdentity | null>;
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
	const rerankRuntime =
		input.dependencies || !policy.rerank_enabled
			? undefined
			: await resolveEffectiveOrganizationRerankRuntime(
					input.identity.tenantId,
				);
	const result = await dependencies.retrieval.retrieve({
		query: payload.query,
		libraryId: payload.library_id,
		scope,
		topK: payload.top_k ?? policy.retrieve_top_k,
		filters: payload.filters,
		options: {
			hybridEnabled: policy.hybrid_enabled,
			rerankEnabled: policy.rerank_enabled,
			...(rerankRuntime &&
			(rerankRuntime.source === "database" || rerankRuntime.rerankCacheTag)
				? {
						...(rerankRuntime.source === "database"
							? { rerankerOverride: rerankRuntime.rerankProvider }
							: {}),
						...(rerankRuntime.rerankCacheTag
							? { rerankCacheTag: rerankRuntime.rerankCacheTag }
							: {}),
					}
				: {}),
		},
		signal: input.signal,
	});
	let currentIdentity = input.identity;
	if (input.refreshIdentity) {
		const refreshed = await input.refreshIdentity();
		if (
			!refreshed ||
			refreshed.mustChangePassword ||
			identityScope(refreshed) !== identityScope(input.identity)
		) {
			throw new NativeRetrievalRequestError(401, "authentication required");
		}
		currentIdentity = refreshed;
	}
	if (dependencies.resolveLibrary) {
		const library = await dependencies.resolveLibrary(
			currentIdentity,
			payload.library_id,
		);
		if (!library) {
			throw new NativeRetrievalRequestError(404, "library not found");
		}
	}
	let authorizedCitations = result.citations;
	if (dependencies.citationAuthorizer && result.citations.length > 0) {
		const allowed = await dependencies.citationAuthorizer.filterAuthorized({
			identity: currentIdentity,
			libraryId: payload.library_id,
			citations: result.citations as unknown as Record<string, unknown>[],
			versionPolicy: "active",
		});
		const allowedRefs = new Set<unknown>(allowed);
		const allowedIds = new Set(
			allowed
				.map((item) => (typeof item.id === "string" ? item.id : null))
				.filter((id): id is string => id !== null),
		);
		authorizedCitations = result.citations.filter(
			(item) => allowedRefs.has(item) || allowedIds.has(item.id),
		);
	}
	const citations = authorizedCitations.map((citation, index) =>
		projectCitation(
			authorizedCitations.length === result.citations.length
				? citation
				: { ...citation, index: index + 1 },
		),
	);
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
