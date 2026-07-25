from __future__ import annotations

import logging
from functools import lru_cache

from pydantic import model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

logger = logging.getLogger(__name__)


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

	# stub | live — live 缺密钥 / Qdrant 不可达时硬失败（不降级 stub；stub 仅测试）
	ask_mode: str = "live"

	# OpenAI-compatible（DashScope 等）。openai_* 与 dashscope_* 为同一客户端别名。
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
	# precise | balanced | narrative | table_heavy
	chunking_profile: str = "balanced"
	chunk_policy_version: str = "v1"
	semantic_chunking_enabled: bool = False
	semantic_chunk_min_chars: int = 1200
	semantic_chunk_break_percentile: int = 85
	# legacy | v2 — v2=IR 结构优先切片
	ingest_pipeline: str = "v2"
	pdf_scan_strategy: str = "partial"
	ocr_enabled: bool = False
	vlm_enabled: bool = False
	vlm_model: str = "qwen-vl-plus"

	mineru_enabled: bool = False
	mineru_url: str = ""
	mineru_timeout_s: float = 120.0
	# <=0 关闭软超时；须 ≤ mineru_timeout_s
	mineru_soft_timeout_s: float = 60.0
	mineru_max_retries: int = 2
	mineru_retry_base_s: float = 30.0
	mineru_retry_max_s: float = 300.0
	mineru_parse_path: str = "/file_parse"
	mineru_mode: str = "auto"
	mineru_use_fake: bool = False

	llm_max_inflight: int = 4
	tool_ask: bool = False
	max_retrieve_retries: int = 1

	# Ask/retrieval product knobs (retrieve_top_k, hybrid, rerank, adjudicate,
	# session_memory, …) live in app.services.ask_defaults — not env/Settings.
	# Resolution: workspace ask_overrides > ASK_DEFAULTS.

	rerank_base_url: str = "https://dashscope.aliyuncs.com/compatible-api/v1"
	rerank_model: str = "qwen3-rerank"
	rerank_top_k: int = 6
	bm25_top_k: int = 20
	rrf_k: int = 60

	# Only used when INTERNAL_AUTH_ENABLED=false (discouraged).
	default_tenant_id: str = "00000000-0000-4000-8000-000000000001"
	default_workspace_id: str = "00000000-0000-4000-8000-000000000002"
	# Prefer true whenever the Next.js BFF is in front of real users.
	internal_auth_enabled: bool = False
	internal_auth_secret: str = ""
	internal_auth_replay_backend: str = "memory"

	# postgres required in product; json is test-only escape hatch.
	metadata_backend: str = "postgres"
	database_url: str = "postgresql+psycopg://meriknow:meriknow@localhost:5432/meriknow"
	metadata_path: str = "data/metadata.json"
	# Preferred shared volume with Next.js. Falls back to document_storage_dir.
	document_storage_root: str = ""
	# Legacy local dir (tests / old FastAPI DocumentStorage helper).
	document_storage_dir: str = "data/documents"
	stub_ingest_simulate: bool = False

	# Redis: HMAC replay store (INTERNAL_AUTH_REPLAY_BACKEND=redis). Not an ingest queue.
	redis_url: str = "redis://localhost:6379"
	max_upload_bytes: int = 52_428_800

	worker_database_url: str = ""
	lifecycle_worker_poll_seconds: float = 1.0
	lifecycle_worker_lease_seconds: int = 120
	lifecycle_worker_heartbeat_seconds: int = 30
	lifecycle_worker_version: str = "lifecycle-worker-v1"
	lifecycle_local_capacity: int = 2
	lifecycle_mineru_capacity: int = 1
	lifecycle_cleanup_enabled: bool = True
	lifecycle_cleanup_batch_size: int = 20
	active_generation_gate_enabled: bool = False
	active_generation_cache_ttl_seconds: float = 0.0
	rag_read_database_url: str = ""

	@model_validator(mode="after")
	def validate_settings(self) -> "Settings":
		if self.mineru_timeout_s <= 0:
			raise ValueError("MINERU_TIMEOUT_S must be positive")
		if self.mineru_soft_timeout_s > 0 and self.mineru_soft_timeout_s > self.mineru_timeout_s:
			raise ValueError("MINERU_SOFT_TIMEOUT_S must be <= MINERU_TIMEOUT_S")
		if self.mineru_max_retries < 0:
			raise ValueError("MINERU_MAX_RETRIES cannot be negative")
		if self.mineru_retry_base_s <= 0:
			raise ValueError("MINERU_RETRY_BASE_S must be positive")
		if self.mineru_retry_max_s < self.mineru_retry_base_s:
			raise ValueError("MINERU_RETRY_MAX_S must be >= MINERU_RETRY_BASE_S")

		if not self.internal_auth_enabled:
			logger.warning(
				"INTERNAL_AUTH_ENABLED=false: all requests share principal_id=development "
				"(ask archive and access scope are not per-user). "
				"Enable internal auth for multi-user private deploys."
			)

		if self.app_env.strip().lower() not in {"prod", "production"}:
			return self
		if not self.internal_auth_enabled:
			raise ValueError("production requires INTERNAL_AUTH_ENABLED=true")
		if len(self.internal_auth_secret.strip()) < 32:
			raise ValueError("production requires INTERNAL_AUTH_SECRET with 32+ characters")
		if self.internal_auth_replay_backend.strip().lower() != "redis":
			raise ValueError("production requires INTERNAL_AUTH_REPLAY_BACKEND=redis")
		if not self.active_generation_gate_enabled:
			raise ValueError("production requires ACTIVE_GENERATION_GATE_ENABLED=true")
		if self.active_generation_cache_ttl_seconds != 0:
			raise ValueError(
				"production requires ACTIVE_GENERATION_CACHE_TTL_SECONDS=0"
			)
		if self.mineru_use_fake:
			raise ValueError("production forbids MINERU_USE_FAKE=true")
		if self.mineru_enabled and not self.mineru_url.strip():
			raise ValueError("production MINERU_ENABLED=true requires MINERU_URL")
		if self.mineru_mode.strip().lower() == "mineru" and not self.mineru_enabled:
			raise ValueError("production MINERU_MODE=mineru requires MINERU_ENABLED=true")
		return self

	@property
	def cors_origin_list(self) -> list[str]:
		return [origin.strip() for origin in self.cors_origins.split(",") if origin.strip()]

	@property
	def resolved_document_storage(self) -> str:
		"""Prefer DOCUMENT_STORAGE_ROOT; fall back to legacy DOCUMENT_STORAGE_DIR."""
		root = self.document_storage_root.strip()
		if root:
			return root
		return self.document_storage_dir.strip() or "data/documents"

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

	@property
	def worker_database_dsn(self) -> str:
		dsn = (self.worker_database_url or self.database_url).strip()
		return dsn.replace("postgresql+psycopg://", "postgresql://", 1)

	@property
	def rag_read_database_dsn(self) -> str:
		dsn = (self.rag_read_database_url or self.database_url).strip()
		return dsn.replace("postgresql+psycopg://", "postgresql://", 1)


@lru_cache
def get_settings() -> Settings:
	return Settings()
