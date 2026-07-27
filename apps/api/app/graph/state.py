"""AskGraph state and injectable callable types."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any, TypedDict

RetrieveFn = Callable[..., list[dict[str, Any]]]
# messages (system + history + current user) , citations
GenerateFn = Callable[[list[dict[str, str]], list[dict[str, Any]]], str]
LoadTableGroupsFn = Callable[..., list[dict[str, Any]]]


class AskState(TypedDict, total=False):
	session_id: str
	question: str
	library_id: str | None
	history: list[dict[str, str]]
	rewritten_question: str
	citations: list[dict[str, Any]]
	answer: str
	refused: bool
	refuse_reason: str | None
	retrieval_attempts: int
	judgement: dict[str, Any]
	retrieval_debug: dict[str, Any]
	trace_id: str
	query_type: str
	route_reason: str
	retrieval_plan: dict[str, Any]
	table_query_plan: dict[str, Any]
	table_execution: dict[str, Any]
	upgrade: str | None
	upgrade_reason: str | None
	downgrade_reason: str | None
