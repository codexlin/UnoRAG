import type { ApiHealth } from "@/lib/api";
import type { Locale } from "@/lib/i18n/locale";

const COLLECTION_EMPTY_ZH =
	"确认 PostgreSQL 中没有生效文档后再初始化空索引。否则请恢复原集合或重新索引生效文档。";

const RECOVERY_ZH: Record<string, string> = {
	qdrant_schema_mismatch:
		"检查 Qdrant 的稠密向量、维度、距离、sparse_v1 稀疏向量配置（modifier: none）和载荷索引。请恢复符合要求的集合，或在新集合中重新索引。",
	qdrant_collection_missing: COLLECTION_EMPTY_ZH,
	qdrant_index_missing: COLLECTION_EMPTY_ZH,
	llm_not_configured:
		"检查 LLM_API_KEY、LLM_BASE_URL 和 CHAT_MODEL，或确认 OPENAI / DASHSCOPE 配置完整。",
	embedding_not_configured:
		"检查 EMBEDDING_API_KEY、EMBEDDING_BASE_URL、EMBEDDING_MODEL 和 EMBEDDING_DIM。独立端点需要独立凭证。",
	judge_not_configured:
		"检查 JUDGE_API_KEY、JUDGE_BASE_URL 和 JUDGE_MODEL。独立端点需要独立凭证，否则裁决模型沿用主模型配置。",
	rerank_not_configured:
		"检查 RERANK_API_KEY、RERANK_BASE_URL 和 RERANK_MODEL。独立端点需要独立凭证。",
	vlm_not_configured:
		"检查 VLM_ENABLED、VLM_MODEL、VLM_API_KEY、VLM_BASE_URL、VLM_TIMEOUT_MS、VLM_MAX_FIGURES_PER_REQUEST 和 VLM_MAX_IMAGE_BYTES。",
};

export function localizeHealthRecovery(
	recovery: string,
	code: string,
	locale: Locale,
): string {
	if (code === "embedding_dimension_mismatch") {
		// Older snapshots can contain a concatenated Chinese and English hint.
		const english = recovery.match(/If your embedding model supports .*$/)?.[0];
		if (locale === "en") return english ?? recovery;
		const actualDimension = english?.match(/set EMBEDDING_DIM=(\d+)/)?.[1];
		const expectedDimension = english?.match(/To use (\d+) dimensions/)?.[1];
		if (actualDimension && expectedDimension)
			return `当前集合的向量维度为 ${actualDimension}，配置的维度为 ${expectedDimension}。若 Embedding 模型支持集合现有维度，请设置 EMBEDDING_DIM=${actualDimension}。若需保留配置的维度，请将 QDRANT_COLLECTION 指向新集合后重新索引。`;
		return "核对 Embedding 模型和集合的向量维度。若需保留当前配置的维度，请将 QDRANT_COLLECTION 指向新集合后重新索引。";
	}
	if (locale === "en") return recovery;
	return (
		RECOVERY_ZH[code === "llm_key_missing" ? "llm_not_configured" : code] ??
		recovery
	);
}

export function healthRecovery(health: ApiHealth, locale: Locale) {
	if (!health.recovery) return null;
	// The health endpoint reports dependency failures before model configuration.
	const code = health.reasons.find(
		(reason) =>
			reason !== "metadata_unavailable" && reason !== "qdrant_unavailable",
	);
	return localizeHealthRecovery(health.recovery, code ?? "", locale);
}
