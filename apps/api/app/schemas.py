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
	snippet: str
	score: float = Field(ge=0, le=1)
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
	library_id: str | None = None
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
	library_id: str | None = Field(default=None, max_length=128)


class LibraryResponse(BaseModel):
	id: str
	name: str
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
	error: str | None = None
	created_at: str
	updated_at: str


class UploadResponse(BaseModel):
	library_id: str
	doc_id: str
	title: str
	filename: str
	chunk_count: int
	status: str
	mode: str
	simulated: bool = False
	error: str | None = None
