import "server-only";

import { sql } from "drizzle-orm";

import {
	modelProviderOverrideFromEnv,
	rerankProviderFromEnv,
	resolveLlmApiKey,
} from "@/core/ai/model-environment";
import {
	aiConfigFromEnv,
	judgeAiConfigFromEnv,
	vlmAiConfigFromEnv,
} from "@/core/ai/provider-registry";
import { QdrantCollectionContractError } from "@/core/retrieval/qdrant/collection-manager";
import { getDatabase } from "@/db";
import { resolveReleaseInfo } from "@/lib/release-info";
import { hasActiveDocuments } from "@/server/observability/native-readiness";
import {
	createQdrantHealthCheck,
	modelConfigurationRecovery,
} from "@/server/observability/provider-health";

type HealthDependencies = {
	checkDatabase: () => Promise<void>;
	checkQdrant: () => Promise<void>;
};

export type HealthProbe = "summary" | "live" | "ready";

let defaultHealthCache:
	| { expiresAt: number; response: Promise<Response> }
	| undefined;

function defaultDependencies(): HealthDependencies {
	return {
		checkDatabase: async () => {
			await getDatabase().execute(sql`select 1`);
		},
		checkQdrant: createQdrantHealthCheck(process.env, {
			hasActiveDocuments: () => hasActiveDocuments(getDatabase()),
		}),
	};
}

function modelConfigurationError(): string | null {
	for (const [code, resolve] of [
		["llm_not_configured", () => aiConfigFromEnv()],
		[
			"embedding_not_configured",
			() => modelProviderOverrideFromEnv("EMBEDDING"),
		],
		["rerank_not_configured", () => rerankProviderFromEnv()],
		["judge_not_configured", () => judgeAiConfigFromEnv()],
		["vlm_not_configured", () => vlmAiConfigFromEnv()],
	] as const) {
		try {
			resolve();
		} catch {
			return code;
		}
	}
	return null;
}

async function buildHealthResponse(
	dependencies: HealthDependencies,
	probe: Exclude<HealthProbe, "live">,
): Promise<Response> {
	const [database, qdrant] = await Promise.allSettled([
		dependencies.checkDatabase(),
		dependencies.checkQdrant(),
	]);
	const metadataOk = database.status === "fulfilled";
	const qdrantOk = qdrant.status === "fulfilled";
	const contractError =
		qdrant.status === "rejected" &&
		qdrant.reason instanceof QdrantCollectionContractError
			? qdrant.reason
			: null;
	const hasLlmKey = Boolean(resolveLlmApiKey());
	const modelError = hasLlmKey ? modelConfigurationError() : "llm_key_missing";
	const reasons: string[] = [];
	if (!metadataOk) reasons.push("metadata_unavailable");
	if (!qdrantOk) reasons.push(contractError?.code ?? "qdrant_unavailable");
	if (modelError) reasons.push(modelError);
	const askReady = metadataOk && qdrantOk && !modelError;
	const chatModel = process.env.CHAT_MODEL?.trim() || "qwen-plus";
	const release = resolveReleaseInfo(process.env);

	return Response.json(
		{
			status: askReady ? "ok" : "degraded",
			service: "unorag-web",
			env: process.env.NODE_ENV || "development",
			release,
			build_ref: process.env.UNORAG_BUILD_REF?.trim() || "development",
			image_digest: release.image_digest,
			chat_model: chatModel,
			judge_model: process.env.JUDGE_MODEL?.trim() || chatModel,
			embedding_model:
				process.env.EMBEDDING_MODEL?.trim() || "text-embedding-v3",
			rerank_model: process.env.RERANK_MODEL?.trim() || null,
			ask_mode: "typescript",
			effective_mode: "typescript",
			graph: "langgraph-ts",
			degraded: !askReady,
			has_llm_key: hasLlmKey,
			qdrant_ok: qdrantOk,
			metadata_backend: "postgres",
			metadata_ok: metadataOk,
			live_ready: metadataOk,
			ask_ready: askReady,
			reasons,
			...(contractError
				? { recovery: contractError.recovery }
				: modelError
					? { recovery: modelConfigurationRecovery(modelError) }
					: {}),
		},
		{
			status:
				probe === "ready" ? (askReady ? 200 : 503) : metadataOk ? 200 : 503,
			headers: { "cache-control": "no-store" },
		},
	);
}

export async function handleNativeHealthRequest(input?: {
	dependencies?: HealthDependencies;
	probe?: HealthProbe;
}): Promise<Response> {
	const probe = input?.probe ?? "summary";
	if (probe === "live") {
		return Response.json(
			{
				status: "ok",
				service: "unorag-web",
				live_ready: true,
			},
			{ headers: { "cache-control": "no-store" } },
		);
	}
	if (input?.dependencies)
		return buildHealthResponse(input.dependencies, probe);
	if (probe === "ready") {
		return buildHealthResponse(defaultDependencies(), "ready");
	}
	const now = Date.now();
	if (!defaultHealthCache || defaultHealthCache.expiresAt <= now) {
		defaultHealthCache = {
			expiresAt: now + 5_000,
			response: buildHealthResponse(defaultDependencies(), "summary"),
		};
	}
	return (await defaultHealthCache.response).clone();
}
