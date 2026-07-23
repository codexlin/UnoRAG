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


class ArchiveTurnResponse(BaseModel):
	id: str
	session_id: str
	library_id: str | None = None
	question: str
	answer: str
	citations: list[Citation] = Field(default_factory=list)
	mode: str
	refused: bool = False
	refuse_reason: str | None = None
	created_at: str


class AskRequest(BaseModel):
	question: str = Field(min_length=1, max_length=4000)
	# Required on HTTP ask paths; validated in router (400 if missing/blank).
	library_id: str | None = Field(default=None, max_length=128)
	session_id: str | None = None


class AskResponse(BaseModel):
	session_id: str
	question: str
	answer: str
	citations: list[Citation]
	mode: str
	refused: bool = False
	refuse_reason: str | None = None
	retrieval_debug: dict[str, object] = Field(default_factory=dict)
	persisted: bool = True
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
