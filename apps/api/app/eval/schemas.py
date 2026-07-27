"""Eval case / result schemas（Phase 1 smoke + hardening）。"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field


class EvalExpect(BaseModel):
	query_type: str | None = None
	refused: bool | None = None
	refuse_reason: str | None = None
	answer_contains: list[str] = Field(default_factory=list)
	# Soft answer points (all should appear); used by ablation reports.
	expected_answer_points: list[str] = Field(default_factory=list)
	judge_reason: str | None = None
	execute_path: str | None = None
	section_substr: str | None = None
	body_substr: str | None = None
	# retrieval：默认按 Recall@K 判命中；max_rank 收紧名次（1-based）
	max_rank: int | None = None
	recall_at_k: int | None = None
	record_type: str | None = None
	# Domain gold (deterministic assertions when observed has citations/hits).
	gold_document_version_ids: list[str] = Field(default_factory=list)
	gold_chunk_ids: list[str] = Field(default_factory=list)
	gold_table_ids: list[str] = Field(default_factory=list)
	# ingest_http
	http_status: int | None = None
	http_status_any: list[int] = Field(default_factory=list)
	doc_status: str | None = None
	error_substr: str | None = None
	detail_substr: str | None = None


class EvalCase(BaseModel):
	id: str
	kind: Literal["ask", "classify", "ingest_chunk", "retrieval", "ingest_http"] = "ask"
	question: str = ""
	library_id: str | None = "lib-eval"
	session_id: str | None = None
	history: list[dict[str, str]] = Field(default_factory=list)
	fixture: str | None = None
	expect: EvalExpect = Field(default_factory=EvalExpect)
	tags: list[str] = Field(default_factory=list)
	# Slice label for ablation reports (single_fact / exact_term / follow_up / …).
	category: str | None = None
	# Ablation matrix id (A0_full, A4_no_rerank, …); None = runner default eval knobs.
	policy_variant: str | None = None
	# Optional ACL / principal context for future live ACL cases.
	allowed_library_ids: list[str] = Field(default_factory=list)
	principal_id: str | None = None


class EvalCaseResult(BaseModel):
	id: str
	ok: bool
	kind: str
	errors: list[str] = Field(default_factory=list)
	observed: dict[str, Any] = Field(default_factory=dict)
	policy_variant: str | None = None
	category: str | None = None
	duration_ms: float | None = None
	skipped: bool = False
	skip_reason: str | None = None
