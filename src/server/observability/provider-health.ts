import { QdrantClient } from "@qdrant/js-client-rest";
import { createClient } from "redis";

export type HealthStatus = "healthy" | "degraded" | "disabled";

export interface ProviderHealthItem {
	code: string;
	label: string;
	kind: "infrastructure" | "ai" | "parser";
	status: HealthStatus;
	mode: "active" | "configuration";
	latency_ms: number | null;
	error_code: string | null;
	recovery: string;
}

export interface ProviderHealthSnapshot {
	checked_at: string;
	items: ProviderHealthItem[];
}

export interface ProviderHealthDependencies {
	checkDatabase: (signal: AbortSignal) => Promise<void>;
	checkRedis?: (signal: AbortSignal) => Promise<void>;
	checkQdrant?: (signal: AbortSignal) => Promise<void>;
}

type Environment = Record<string, string | undefined>;

function positiveInteger(
	environment: Environment,
	name: string,
	fallback: number,
): number {
	const value = Number(environment[name] ?? fallback);
	return Number.isInteger(value) && value > 0 ? value : fallback;
}

async function bounded(
	operation: (signal: AbortSignal) => Promise<void>,
	timeoutMs: number,
) {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);
	try {
		await Promise.race([
			operation(controller.signal),
			new Promise<never>((_, reject) =>
				controller.signal.addEventListener(
					"abort",
					() => reject(new Error("probe_timeout")),
					{ once: true },
				),
			),
		]);
	} finally {
		clearTimeout(timeout);
	}
}

function configured(value: string | undefined): boolean {
	return Boolean(value?.trim());
}

function environmentBoolean(
	environment: Environment,
	name: string,
	fallback = false,
): boolean {
	const value = environment[name]?.trim().toLowerCase();
	if (!value) return fallback;
	return value === "true" || value === "1";
}

function configurationItem(input: {
	code: string;
	label: string;
	kind: ProviderHealthItem["kind"];
	enabled?: boolean;
	ready: boolean;
	recovery: string;
}): ProviderHealthItem {
	const enabled = input.enabled ?? true;
	return {
		code: input.code,
		label: input.label,
		kind: input.kind,
		status: !enabled ? "disabled" : input.ready ? "healthy" : "degraded",
		mode: "configuration",
		latency_ms: null,
		error_code: !enabled
			? null
			: input.ready
				? null
				: `${input.code}_not_configured`,
		recovery: input.recovery,
	};
}

async function activeItem(input: {
	code: string;
	label: string;
	kind?: ProviderHealthItem["kind"];
	check: (signal: AbortSignal) => Promise<void>;
	timeoutMs: number;
	recovery: string;
}): Promise<ProviderHealthItem> {
	const startedAt = Date.now();
	try {
		await bounded(input.check, input.timeoutMs);
		return {
			code: input.code,
			label: input.label,
			kind: input.kind ?? "infrastructure",
			status: "healthy",
			mode: "active",
			latency_ms: Date.now() - startedAt,
			error_code: null,
			recovery: input.recovery,
		};
	} catch (error) {
		return {
			code: input.code,
			label: input.label,
			kind: input.kind ?? "infrastructure",
			status: "degraded",
			mode: "active",
			latency_ms: Date.now() - startedAt,
			error_code:
				error instanceof Error && error.message === "probe_timeout"
					? `${input.code}_timeout`
					: `${input.code}_unavailable`,
			recovery: input.recovery,
		};
	}
}

function defaultRedisCheck(
	environment: Environment,
	timeoutMs: number,
): ((signal: AbortSignal) => Promise<void>) | undefined {
	const url = environment.REDIS_URL?.trim();
	if (!url) return undefined;
	return async (signal) => {
		const client = createClient({
			url,
			socket: { connectTimeout: timeoutMs, reconnectStrategy: false },
		});
		const abort = () => {
			try {
				client.destroy();
			} catch {
				// The client may not have opened a socket yet.
			}
		};
		signal.addEventListener("abort", abort, { once: true });
		try {
			await client.connect();
			await client.ping();
		} finally {
			signal.removeEventListener("abort", abort);
			if (client.isOpen) client.disconnect();
		}
	};
}

function defaultQdrantCheck(
	environment: Environment,
): (signal: AbortSignal) => Promise<void> {
	return async () => {
		const client = new QdrantClient({
			url: environment.QDRANT_URL?.trim() || "http://localhost:6333",
			apiKey: environment.QDRANT_API_KEY?.trim() || undefined,
			timeout: positiveInteger(environment, "QDRANT_TIMEOUT_MS", 5_000),
			checkCompatibility: false,
		});
		const collection = environment.QDRANT_COLLECTION?.trim() || "unorag_chunks";
		const result = await client.collectionExists(collection);
		if (!result.exists) throw new Error("collection_missing");
	};
}

/**
 * Active probes are limited to non-billable infrastructure. AI providers are
 * represented by safe configuration readiness; their real-call failures are
 * already reflected by Ask/job diagnostics and alerts.
 */
export async function readProviderHealth(
	dependencies: ProviderHealthDependencies,
	options: { now?: Date; timeoutMs?: number; environment?: Environment } = {},
): Promise<ProviderHealthSnapshot> {
	const environment = options.environment ?? process.env;
	const timeoutMs =
		options.timeoutMs ??
		positiveInteger(environment, "HEALTH_PROBE_TIMEOUT_MS", 2_000);
	const redisCheck =
		dependencies.checkRedis ?? defaultRedisCheck(environment, timeoutMs);
	const qdrantCheck =
		dependencies.checkQdrant ?? defaultQdrantCheck(environment);
	const active = await Promise.all([
		activeItem({
			code: "postgres",
			label: "PostgreSQL",
			check: dependencies.checkDatabase,
			timeoutMs,
			recovery: "检查数据库连接、容量和运行时账号权限。",
		}),
		redisCheck
			? activeItem({
					code: "redis",
					label: "Redis",
					check: redisCheck,
					timeoutMs,
					recovery: "检查 Redis 服务、网络和 REDIS_URL。",
				})
			: Promise.resolve(
					configurationItem({
						code: "redis",
						label: "Redis",
						kind: "infrastructure",
						ready: false,
						recovery: "配置 REDIS_URL 并确认服务可访问。",
					}),
				),
		activeItem({
			code: "qdrant",
			label: "Qdrant",
			check: qdrantCheck,
			timeoutMs,
			recovery: "检查 Qdrant 服务、集合和 API Key。",
		}),
	]);

	const hasModelKey =
		configured(environment.OPENAI_API_KEY) ||
		configured(environment.DASHSCOPE_API_KEY);
	const rerankEnabled = environmentBoolean(
		environment,
		"TS_RETRIEVAL_RERANK_ENABLED",
	);
	const externalParserAllowed = environmentBoolean(
		environment,
		"EXTERNAL_PARSER_ALLOWED",
	);
	const mineruConfigured =
		configured(environment.MINERU_SELF_HOSTED_URL) ||
		configured(environment.MINERU_URL) ||
		(configured(environment.MINERU_API_KEY) && externalParserAllowed);
	return {
		checked_at: (options.now ?? new Date()).toISOString(),
		items: [
			...active,
			configurationItem({
				code: "llm",
				label: "LLM",
				kind: "ai",
				ready: hasModelKey && configured(environment.CHAT_MODEL),
				recovery: "检查模型 API Key、CHAT_MODEL 和兼容端点配置。",
			}),
			configurationItem({
				code: "embedding",
				label: "Embedding",
				kind: "ai",
				ready:
					hasModelKey &&
					configured(environment.EMBEDDING_MODEL) &&
					positiveInteger(environment, "EMBEDDING_DIM", 0) > 0,
				recovery: "检查模型凭证、EMBEDDING_MODEL 与 EMBEDDING_DIM。",
			}),
			configurationItem({
				code: "rerank",
				label: "Rerank",
				kind: "ai",
				enabled: rerankEnabled,
				ready:
					hasModelKey &&
					configured(environment.RERANK_BASE_URL) &&
					configured(environment.RERANK_MODEL),
				recovery: "检查 Rerank 开关、模型和独立兼容端点。",
			}),
			configurationItem({
				code: "mineru",
				label: "MinerU",
				kind: "parser",
				enabled: mineruConfigured,
				ready: mineruConfigured,
				recovery: "检查 MinerU 地址、授权和 EXTERNAL_PARSER_ALLOWED。",
			}),
			configurationItem({
				code: "liteparse",
				label: "LiteParse",
				kind: "parser",
				ready: true,
				recovery: "重新构建运行镜像并验证 LiteParse WASM 资源。",
			}),
		],
	};
}
