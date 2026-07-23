"""Eval case / result schemas（Phase 1 smoke）。"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field


class EvalExpect(BaseModel):
	query_type: str | None = None
	refused: bool | None = None
	refuse_reason: str | None = None
	answer_contains: list[str] = Field(default_factory=list)
	judge_reason: str | None = None
	execute_path: str | None = None
	section_substr: str | None = None
	body_substr: str | None = None


class EvalCase(BaseModel):
	id: str
	kind: Literal["ask", "classify", "ingest_chunk", "retrieval"] = "ask"
	question: str = ""
	library_id: str | None = "lib-eval"
	session_id: str | None = None
	history: list[dict[str, str]] = Field(default_factory=list)
	fixture: str | None = None
	expect: EvalExpect = Field(default_factory=EvalExpect)
	tags: list[str] = Field(default_factory=list)


class EvalCaseResult(BaseModel):
	id: str
	ok: bool
	kind: str
	errors: list[str] = Field(default_factory=list)
	observed: dict[str, Any] = Field(default_factory=dict)
