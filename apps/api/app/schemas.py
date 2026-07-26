from __future__ import annotations

from pydantic import BaseModel, Field


class HealthResponse(BaseModel):
	status: str = "ok"
	service: str
	env: str
	ask_mode: str
	effective_mode: str = "live"
	graph: str = "ask_v1"
	degraded: bool = False
	has_llm_key: bool = False
	qdrant_ok: bool = False
	live_ready: bool = False
	ask_ready: bool = False
	reasons: list[str] = Field(default_factory=list)
	hybrid_enabled: bool = False
	metadata_backend: str = "postgres"
	metadata_ok: bool = True
	active_generation_gate_enabled: bool = False
	active_generation_gate_ok: bool = True


class Citation(BaseModel):
	id: str
	index: int
	title: str
	page: str | None = None
	page_start: int | None = None
	page_end: int | None = None
	section_path: str | None = None
	preamble: str | None = None
	table_id: str | None = None
	row_start: int | None = None
	row_end: int | None = None
	headers: list[str] = Field(default_factory=list)
	rows: list[list[str]] = Field(default_factory=list)
	snippet: str
	# Full chunk body used in LLM context / drawer（不含 preamble）.
	text: str = ""
	body: str = ""
	# Final ranking score shown in UI (after hybrid/rerank when applicable).
	score: float = Field(ge=0, le=1)
	dense_score: float | None = None
	bm25_score: float | None = None
	rrf_score: float | None = None
	used_rerank: bool = False
	used_hybrid: bool = False
	doc_id: str | None = None
	chunk_index: int | None = None
	filename: str | None = None
	# Lifecycle V2 uses the real version/generation IDs; legacy points retain
	# the deterministic version stub during migration.
	document_version_id: str | None = None
	# 与 Phase 1 Qdrant payload / 检索 hit 对齐，便于端到端对账
	generation_id: str | None = None
	tenant_id: str | None = None
	# Phase 2A/2B：多粒度
	record_type: str | None = None
	record_id: str | None = None
	source_chunk_ids: list[str] = Field(default_factory=list)
	source_node_ids: list[str] = Field(default_factory=list)


class ArchiveTurnResponse(BaseModel):
	id: str
	session_id: str
	thread_id: str | None = None
	library_id: str | None = None
	question: str
	answer: str
	citations: list[Citation] = Field(default_factory=list)
	mode: str
	refused: bool = False
	refuse_reason: str | None = None
	# Phase 1：可审计字段（可选，旧客户端忽略）
	query_type: str | None = None
	rewrite: str | None = None
	rewritten_query: str | None = None
	judge: dict[str, object] | None = None
	retrieval_plan: dict[str, object] | None = None
	# Same-origin as Ask UI /stream done.retrieval_debug (sanitized for archive).
	retrieval_debug: dict[str, object] | None = None
	document_version_id: str | None = None
	tenant_id: str | None = None
	created_at: str


class ArchiveDebugResponse(BaseModel):
	"""Internal debug projection for replaying Ask adjudicate / retrieve without UI."""

	turn_id: str
	session_id: str
	thread_id: str | None = None
	library_id: str | None = None
	created_at: str
	refused: bool = False
	refuse_reason: str | None = None
	trace_id: str | None = None
	question_hash: str | None = None
	# Sanitized; includes stages (adjudicate), citation_adjudication, path/route.
	retrieval_debug: dict[str, object] = Field(default_factory=dict)


class ArchiveTurnInput(BaseModel):
	"""Client-side temp turn payload used when explicitly archiving a session."""

	question: str = Field(min_length=1, max_length=4000)
	answer: str = ""
	citations: list[Citation] = Field(default_factory=list)
	mode: str = "stub"
	refused: bool = False
	refuse_reason: str | None = None
	library_id: str | None = None


class ArchiveThreadRequest(BaseModel):
	"""Persist a temporary conversation into a Thread + Turns (explicit archive)."""

	session_id: str | None = None
	title: str | None = Field(default=None, max_length=256)
	library_id: str | None = Field(default=None, max_length=128)
	turns: list[ArchiveTurnInput] = Field(min_length=1)


class ThreadResponse(BaseModel):
	"""Archived conversation.

	status=active means persisted and open for continue-chat.
	Temporary chats have no Thread row and do not appear in lists.
	status=hidden soft-hides from the archive list (reserved).
	"""

	id: str
	session_id: str | None = None
	library_id: str | None = None
	title: str
	status: str
	tenant_id: str | None = None
	workspace_id: str | None = None
	principal_id: str | None = None
	turn_count: int = 0
	created_at: str
	updated_at: str


class ThreadDetailResponse(ThreadResponse):
	turns: list[ArchiveTurnResponse] = Field(default_factory=list)


class AskRequest(BaseModel):
	question: str = Field(min_length=1, max_length=4000)
	# Required on HTTP ask paths; validated in router (400 if missing/blank).
	library_id: str | None = Field(default=None, max_length=128)
	session_id: str | None = None
	# Bound archived thread: load DB history + persist new turns. Omit = temporary.
	thread_id: str | None = None
	# Workspace product knobs for this request only (unset keys → code ASK_DEFAULTS).
	ask_overrides: dict[str, object] | None = None


class RetrieveRequest(BaseModel):
	"""Evidence-only retrieval for Mode B (no answer generation)."""

	query: str = Field(min_length=1, max_length=4000)
	library_id: str = Field(min_length=1, max_length=128)
	top_k: int | None = Field(default=None, ge=1, le=50)
	filters: dict[str, object] | None = None
	# Workspace product knobs for this request only (unset keys → code ASK_DEFAULTS).
	ask_overrides: dict[str, object] | None = None


class RetrieveResponse(BaseModel):
	query: str
	library_id: str
	citations: list[Citation]
	refused: bool = False
	refuse_reason: str | None = None
	retrieval_mode: str = "dense"
	retrieval_debug: dict[str, object] = Field(default_factory=dict)


class AskResponse(BaseModel):
	session_id: str
	thread_id: str | None = None
	question: str
	answer: str
	citations: list[Citation]
	mode: str
	refused: bool = False
	refuse_reason: str | None = None
	retrieval_debug: dict[str, object] = Field(default_factory=dict)
	# True only when written to an archived thread; temp asks stay False.
	persisted: bool = False
	persist_error: str | None = None
	hybrid_failed: bool = False
	rerank_failed: bool = False
	retrieval_mode: str = "dense"


class IngestRequest(BaseModel):
	library_id: str = Field(min_length=1, max_length=128)
	title: str = Field(min_length=1, max_length=512)
	text: str = Field(min_length=1, max_length=200_000)
	doc_id: str | None = None


class IngestResponse(BaseModel):
	library_id: str
	doc_id: str
	title: str
	chunk_count: int
	mode: str = "live"
	status: str = "ready"
	simulated: bool = False


class LibraryCreateRequest(BaseModel):
	name: str = Field(min_length=1, max_length=256)
	description: str | None = Field(default=None, max_length=2000)
	library_id: str | None = Field(default=None, max_length=128)


class LibraryUpdateRequest(BaseModel):
	name: str | None = Field(default=None, min_length=1, max_length=256)
	description: str | None = Field(default=None, max_length=2000)


class LibraryProjectionRequest(BaseModel):
	name: str = Field(min_length=1, max_length=256)
	description: str | None = Field(default=None, max_length=2000)


class LibraryResponse(BaseModel):
	id: str
	name: str
	description: str | None = None
	status: str
	doc_count: int
	ready_count: int
	created_at: str
	updated_at: str


class DocumentResponse(BaseModel):
	id: str
	library_id: str
	name: str
	filename: str
	content_type: str
	status: str
	chunk_count: int
	size_bytes: int | None = None
	error: str | None = None
	parser_report: dict[str, object] | None = None
	storage_key: str | None = None
	has_file: bool = False
	created_at: str
	updated_at: str


class UploadResponse(BaseModel):
	library_id: str
	doc_id: str
	title: str
	filename: str
	chunk_count: int = 0
	status: str
	mode: str
	simulated: bool = False
	accepted: bool = False
	error: str | None = None
	notice: str | None = None
	parser_report: dict[str, object] | None = None
	pipeline: str | None = None
