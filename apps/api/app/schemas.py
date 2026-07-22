from __future__ import annotations

from pydantic import BaseModel, Field


class HealthResponse(BaseModel):
	status: str = "ok"
	service: str
	env: str
	ask_mode: str
	graph: str = "stub"


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
	retrieval_debug: dict[str, object] = Field(default_factory=dict)
