from __future__ import annotations

from pydantic import BaseModel, Field


class HealthResponse(BaseModel):
	status: str = "ok"
	service: str
	env: str
	ask_mode: str
	effective_mode: str = "stub"
	graph: str = "ask_v1"
	degraded: bool = False
	has_llm_key: bool = False
	qdrant_ok: bool = False
	reasons: list[str] = Field(default_factory=list)


class Citation(BaseModel):
	id: str
	index: int
	title: str
	page: str | None = None
	snippet: str
	score: float = Field(ge=0, le=1)


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
