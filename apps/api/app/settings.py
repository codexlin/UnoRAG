from __future__ import annotations

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
	model_config = SettingsConfigDict(
		env_file=".env",
		env_file_encoding="utf-8",
		extra="ignore",
	)

	app_name: str = "MeriKnow API"
	app_env: str = "development"
	api_prefix: str = "/v1"
	cors_origins: str = "http://localhost:3000,http://127.0.0.1:3000"

	# stub | live — live 在缺密钥 / Qdrant 不可达时自动降级为 stub
	ask_mode: str = "stub"

	# OpenAI-compatible（DashScope 等）
	openai_api_key: str = ""
	openai_base_url: str = "https://dashscope.aliyuncs.com/compatible-mode/v1"
	dashscope_api_key: str = ""
	dashscope_base_url: str = "https://dashscope.aliyuncs.com/compatible-mode/v1"
	chat_model: str = "qwen-plus"
	embedding_model: str = "text-embedding-v3"
	embedding_dim: int = 1024
	embedding_batch_size: int = 10

	qdrant_url: str = "http://localhost:6333"
	qdrant_collection: str = "meriknow_chunks"
	qdrant_timeout_s: float = 2.0

	chunk_size: int = 500
	chunk_overlap: int = 80
	retrieve_top_k: int = 6
	# 最高分低于此阈值则拒答（0 = 关闭弱相关拒答）；无命中始终拒答
	answer_min_score: float = 0.35
	max_retrieve_retries: int = 1

	# Optional rerank after dense retrieval (DashScope-compatible /reranks)
	rerank_enabled: bool = False
	rerank_base_url: str = "https://dashscope.aliyuncs.com/compatible-api/v1"
	rerank_model: str = "qwen3-rerank"
	rerank_top_k: int = 6
	# When True and session has prior turns, rewrite query with short history
	session_memory_enabled: bool = True
	session_memory_max_turns: int = 6

	# Dense + BM25 hybrid (RRF). Failures fall back to dense-only.
	hybrid_enabled: bool = False
	bm25_top_k: int = 20
	rrf_k: int = 60

	# Metadata is Postgres-required in production/dev.
	# METADATA_BACKEND=json is test-only escape hatch (never silent fallback).
	metadata_backend: str = "postgres"
	database_url: str = "postgresql+psycopg://meriknow:meriknow@localhost:5432/meriknow"
	metadata_path: str = "data/metadata.json"
	# stub upload: simulate ready without Qdrant (live still embeds)
	stub_ingest_simulate: bool = True

	@property
	def cors_origin_list(self) -> list[str]:
		return [origin.strip() for origin in self.cors_origins.split(",") if origin.strip()]

	@property
	def llm_api_key(self) -> str:
		return (self.openai_api_key or self.dashscope_api_key).strip()

	@property
	def llm_base_url(self) -> str:
		return (self.openai_base_url or self.dashscope_base_url).rstrip("/")

	@property
	def wants_live(self) -> bool:
		return self.ask_mode.strip().lower() == "live"

	@property
	def has_llm_key(self) -> bool:
		return bool(self.llm_api_key)

	@property
	def uses_postgres_metadata(self) -> bool:
		return self.metadata_backend.strip().lower() != "json"


@lru_cache
def get_settings() -> Settings:
	return Settings()
