import "server-only";

import { QdrantClient } from "@qdrant/js-client-rest";
import { sql } from "drizzle-orm";

import { getDatabase } from "@/db";

type HealthDependencies = {
	checkDatabase: () => Promise<void>;
	checkQdrant: () => Promise<void>;
};

let defaultHealthCache:
	| { expiresAt: number; response: Promise<Response> }
	| undefined;

function positiveInteger(name: string, fallback: number): number {
	const value = Number(process.env[name] ?? fallback);
	return Number.isInteger(value) && value > 0 ? value : fallback;
}

function defaultDependencies(): HealthDependencies {
	return {
		checkDatabase: async () => {
			await getDatabase().execute(sql`select 1`);
		},
		checkQdrant: async () => {
			const client = new QdrantClient({
				url: process.env.QDRANT_URL?.trim() || "http://localhost:6333",
				apiKey: process.env.QDRANT_API_KEY?.trim() || undefined,
				timeout: positiveInteger("QDRANT_TIMEOUT_MS", 5_000),
				checkCompatibility: false,
			});
			const collection =
				process.env.QDRANT_COLLECTION?.trim() || "unorag_chunks";
			const result = await client.collectionExists(collection);
			if (!result.exists) throw new Error("Qdrant collection is missing");
		},
	};
}

async function buildHealthResponse(
	dependencies: HealthDependencies,
): Promise<Response> {
	const [database, qdrant] = await Promise.allSettled([
		dependencies.checkDatabase(),
		dependencies.checkQdrant(),
	]);
	const metadataOk = database.status === "fulfilled";
	const qdrantOk = qdrant.status === "fulfilled";
	const hasLlmKey = Boolean(
		process.env.OPENAI_API_KEY?.trim() || process.env.DASHSCOPE_API_KEY?.trim(),
	);
	const reasons: string[] = [];
	if (!metadataOk) reasons.push("metadata_unavailable");
	if (!qdrantOk) reasons.push("qdrant_unavailable");
	if (!hasLlmKey) reasons.push("llm_key_missing");
	const askReady = metadataOk && qdrantOk && hasLlmKey;

	return Response.json(
		{
			status: askReady ? "ok" : "degraded",
			service: "unorag-web",
			env: process.env.NODE_ENV || "development",
			build_ref: process.env.UNORAG_BUILD_REF?.trim() || "development",
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
		},
		{
			status: metadataOk ? 200 : 503,
			headers: { "cache-control": "no-store" },
		},
	);
}

export async function handleNativeHealthRequest(input?: {
	dependencies?: HealthDependencies;
}): Promise<Response> {
	if (input?.dependencies) return buildHealthResponse(input.dependencies);
	const now = Date.now();
	if (!defaultHealthCache || defaultHealthCache.expiresAt <= now) {
		defaultHealthCache = {
			expiresAt: now + 5_000,
			response: buildHealthResponse(defaultDependencies()),
		};
	}
	return (await defaultHealthCache.response).clone();
}
