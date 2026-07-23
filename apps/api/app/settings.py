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

	# stub | live — live 缺密钥 / Qdrant 不可达时硬失败（不降级 stub；stub 仅测试）
	ask_mode: str = "live"

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
	# legacy | v2 — v2=IR 结构优先切片；md/txt/pdf/docx 走新管线
	ingest_pipeline: str = "v2"
	# PDF 扫描/失败页：partial=成功页入库+notice；fail=无成功页则整本失败
	pdf_scan_strategy: str = "partial"
	ocr_enabled: bool = False
	vlm_enabled: bool = False
	vlm_model: str = "qwen-vl-plus"
	# Phase 2C MinerU：独立服务补充扫描/复杂 PDF（默认关闭，不替换 PyMuPDF）
	mineru_enabled: bool = False
	mineru_url: str = ""
	mineru_timeout_s: float = 120.0
	mineru_max_retries: int = 2
	mineru_parse_path: str = "/parse"
	# auto | pymupdf | mineru
	mineru_mode: str = "auto"
	# 单测 / 本地无服务：true 时用 FakeMinerUBackend（勿用于生产）
	mineru_use_fake: bool = False
	# 可选 LangGraph 工具化 ask；默认短路径 retrieve→generate
	tool_ask: bool = False
	retrieve_top_k: int = 6
	# 最高分低于此阈值则拒答（0 = 关闭弱相关拒答）；无命中始终拒答
	# 最高分低于此值 → 正式 refused（弱相关），避免模型口头「未覆盖」却 refused=false
	answer_min_score: float = 0.4
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

	# SaaS 预埋（Phase 1：默认租户/工作区 stub，完整多租户后置）
	default_tenant_id: str = "default"
	default_workspace_id: str = "default"

	# Metadata is Postgres-required in production/dev.
	# METADATA_BACKEND=json is test-only escape hatch (never silent fallback).
	metadata_backend: str = "postgres"
	database_url: str = "postgresql+psycopg://meriknow:meriknow@localhost:5432/meriknow"
	metadata_path: str = "data/metadata.json"
	document_storage_dir: str = "data/documents"
	# stub upload: simulate ready without Qdrant (false=503；仅测试可 true)
	stub_ingest_simulate: bool = False

	# 异步索引：true=落盘后入队返回 202；false=同请求内同步 ingest（本地/测试）
	ingest_async: bool = True
	redis_url: str = "redis://localhost:6379"
	max_upload_bytes: int = 52_428_800  # 50 MiB
	ingest_queue_max_depth: int = 100
	ingest_max_inflight_per_library: int = 8
	ingest_worker_max_jobs: int = 2
	ingest_job_timeout_s: int = 600

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
