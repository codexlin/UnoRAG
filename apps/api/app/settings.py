from __future__ import annotations

import logging
from functools import lru_cache
from urllib.parse import urlparse

from pydantic import model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

logger = logging.getLogger(__name__)

_PLACEHOLDER_SECRET_MARKERS = (
	"replace-with-random",
	"change-me",
	"change-this",
	"changeme",
	"your-secret",
	"todo",
)


def _looks_like_placeholder(value: str) -> bool:
	normalized = value.strip().lower()
	if not normalized:
		return True
	return any(marker in normalized for marker in _PLACEHOLDER_SECRET_MARKERS)


def _redacted_url_host(url: str) -> str:
	"""Hostname[:port] only — never userinfo (user:pass@host)."""
	raw = (url or "").strip()
	if not raw:
		return ""
	parsed = urlparse(raw)
	host = parsed.hostname
	if not host:
		# Non-URL / opaque value: return as-is only if it cannot contain userinfo.
		if "@" in raw:
			return "[redacted-host]"
		return raw
	if parsed.port is not None:
		return f"{host}:{parsed.port}"
	return host


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
	# self_hosted | 302ai. Legacy MINERU_URL remains the self-hosted URL.
	mineru_provider: str = "self_hosted"
	mineru_url: str = ""
	mineru_self_hosted_url: str = ""
	mineru_timeout_s: float = 120.0
	# <=0 关闭软超时；须 ≤ mineru_timeout_s
	mineru_soft_timeout_s: float = 60.0
	mineru_max_retries: int = 2
	mineru_retry_base_s: float = 30.0
	mineru_retry_max_s: float = 300.0
	mineru_parse_path: str = "/file_parse"
	mineru_mode: str = "auto"
	mineru_version: str = "2.5"
	mineru_parse_method: str = "auto"
	mineru_302_api_key: str = ""
	mineru_302_base_url: str = "https://api.302.ai"
	mineru_302_upload_path: str = "/302/upload-file"
	mineru_302_task_path: str = "/302/v2/mineru/task"
	mineru_302_poll_interval_s: float = 5.0
	mineru_302_max_wait_s: float = 900.0
	# Cost control (non-secret). 0 daily budget = gate disabled.
	# DEFAULT_COST_PER_PAGE placeholder — set real rate from 302 billing.
	mineru_302_cost_per_page: float = 0.02
	mineru_302_daily_budget: float = 0.0
	mineru_302_budget_warn_ratio: float = 0.8
	# Warn when async wait exceeds this many seconds (structured log).
	mineru_302_long_pending_s: float = 300.0
	external_parser_allowed: bool = False
	mineru_use_fake: bool = False
	# 短窗熔断：连续 unreachable 后跳过 HTTP；不进设置页旋钮。
	mineru_circuit_failure_threshold: int = 3
	mineru_circuit_open_seconds: float = 90.0

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
		if self.mineru_circuit_failure_threshold < 1:
			raise ValueError("MINERU_CIRCUIT_FAILURE_THRESHOLD must be >= 1")
		if self.mineru_circuit_open_seconds < 1:
			raise ValueError("MINERU_CIRCUIT_OPEN_SECONDS must be >= 1")
		provider = self.resolved_mineru_provider
		if provider not in {"self_hosted", "302ai"}:
			raise ValueError("MINERU_PROVIDER must be self_hosted or 302ai")
		if self.mineru_302_poll_interval_s < 1:
			raise ValueError("MINERU_302_POLL_INTERVAL_S must be >= 1")
		if self.mineru_302_max_wait_s < self.mineru_302_poll_interval_s:
			raise ValueError(
				"MINERU_302_MAX_WAIT_S must be >= MINERU_302_POLL_INTERVAL_S"
			)
		if self.mineru_302_cost_per_page < 0:
			raise ValueError("MINERU_302_COST_PER_PAGE cannot be negative")
		if self.mineru_302_daily_budget < 0:
			raise ValueError("MINERU_302_DAILY_BUDGET cannot be negative")
		if not 0.0 <= self.mineru_302_budget_warn_ratio <= 1.0:
			raise ValueError("MINERU_302_BUDGET_WARN_RATIO must be in [0, 1]")
		if self.mineru_302_long_pending_s < 0:
			raise ValueError("MINERU_302_LONG_PENDING_S cannot be negative")
		if self.embedding_dim <= 0:
			raise ValueError("EMBEDDING_DIM must be > 0")
		if self.lifecycle_worker_heartbeat_seconds * 2 >= self.lifecycle_worker_lease_seconds:
			raise ValueError(
				"LIFECYCLE_WORKER_HEARTBEAT_SECONDS must be < LIFECYCLE_WORKER_LEASE_SECONDS / 2"
			)

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
		secret = self.internal_auth_secret.strip()
		if len(secret) < 32:
			raise ValueError("production requires INTERNAL_AUTH_SECRET with 32+ characters")
		if _looks_like_placeholder(secret):
			raise ValueError("production forbids placeholder INTERNAL_AUTH_SECRET")
		if self.internal_auth_replay_backend.strip().lower() != "redis":
			raise ValueError("production requires INTERNAL_AUTH_REPLAY_BACKEND=redis")
		if not self.redis_url.strip():
			raise ValueError("production requires REDIS_URL")
		if not self.qdrant_url.strip():
			raise ValueError("production requires QDRANT_URL")
		if not self.document_storage_root.strip():
			raise ValueError(
				"production requires DOCUMENT_STORAGE_ROOT "
				"(do not rely on DOCUMENT_STORAGE_DIR / data/documents fallback)"
			)
		if not self.database_url.strip():
			raise ValueError("production requires DATABASE_URL / API_DATABASE_URL")
		db_scheme = urlparse(self.database_url).scheme.lower()
		if db_scheme not in {"postgresql", "postgresql+psycopg", "postgres"}:
			raise ValueError(
				"production DATABASE_URL must use postgresql:// or postgresql+psycopg://"
			)
		if not self.has_llm_key or _looks_like_placeholder(self.llm_api_key):
			raise ValueError("production requires a real LLM/OpenAI API key")
		if not self.llm_base_url.strip():
			raise ValueError("production requires OPENAI_BASE_URL / LLM_BASE_URL")
		if not self.active_generation_gate_enabled:
			raise ValueError("production requires ACTIVE_GENERATION_GATE_ENABLED=true")
		if self.active_generation_cache_ttl_seconds != 0:
			raise ValueError(
				"production requires ACTIVE_GENERATION_CACHE_TTL_SECONDS=0"
			)
		if self.mineru_use_fake:
			raise ValueError("production forbids MINERU_USE_FAKE=true")
		if (
			self.mineru_enabled
			and provider == "self_hosted"
			and not self.resolved_mineru_self_hosted_url
		):
			raise ValueError(
				"production self-hosted MinerU requires "
				"MINERU_SELF_HOSTED_URL or legacy MINERU_URL"
			)
		if self.mineru_enabled and provider == "302ai":
			if not self.external_parser_allowed:
				raise ValueError(
					"production 302 MinerU requires EXTERNAL_PARSER_ALLOWED=true"
				)
		if self.mineru_mode.strip().lower() == "mineru" and not self.mineru_enabled:
			raise ValueError("production MINERU_MODE=mineru requires MINERU_ENABLED=true")
		return self

	def redacted_effective_config(self) -> dict[str, object]:
		"""Safe-to-log deployment summary (no secret values)."""
		return {
			"app_env": self.app_env,
			"database": "configured" if self.database_url.strip() else "missing",
			"rag_read_database": "configured" if self.rag_read_database_url.strip() else "default",
			"worker_database": "configured" if self.worker_database_url.strip() else "default",
			"qdrant_host": _redacted_url_host(self.qdrant_url),
			"redis": "configured" if self.redis_url.strip() else "missing",
			"document_storage": self.resolved_document_storage or "missing",
			"llm_provider_host": _redacted_url_host(self.llm_base_url),
			"chat_model": self.chat_model,
			"embedding_model": self.embedding_model,
			"embedding_dim": self.embedding_dim,
			"internal_auth": "enabled" if self.internal_auth_enabled else "disabled",
			"mineru_enabled": self.mineru_enabled,
			"mineru_provider": self.resolved_mineru_provider,
			"external_parser": (
				"allowed" if self.external_parser_allowed else "forbidden"
			),
			"mineru_302_cost_per_page": self.mineru_302_cost_per_page,
			"mineru_302_daily_budget": self.mineru_302_daily_budget,
			"secret_values": "[REDACTED]",
		}

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
	def resolved_mineru_provider(self) -> str:
		value = (self.mineru_provider or "self_hosted").strip().lower()
		return "302ai" if value in {"302", "302_ai", "302ai"} else value.replace("-", "_")

	@property
	def resolved_mineru_self_hosted_url(self) -> str:
		return (self.mineru_self_hosted_url or self.mineru_url).strip()

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
