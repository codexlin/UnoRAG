"""Typed request/response models matching frozen public API v1 fields."""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any, Mapping, Optional


@dataclass(frozen=True)
class RetrieveFilters:
    """Optional retrieve filters (only these four keys are allowed by v1)."""

    record_type: Optional[str] = None
    doc_id: Optional[str] = None
    table_id: Optional[str] = None
    document_version_id: Optional[str] = None

    def to_dict(self) -> dict[str, str]:
        out: dict[str, str] = {}
        for key, value in asdict(self).items():
            if value is not None:
                out[key] = value
        return out


@dataclass(frozen=True)
class Citation:
    id: str
    index: int
    title: str
    snippet: str
    score: float
    document_id: Optional[str]
    filename: Optional[str]
    page: Optional[str]
    page_start: Optional[int]
    page_end: Optional[int]
    section_path: Optional[str]
    table_id: Optional[str]
    row_start: Optional[int]
    row_end: Optional[int]
    record_type: Optional[str]

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> Citation:
        return cls(
            id=str(data["id"]),
            index=int(data["index"]),
            title=str(data["title"]),
            snippet=str(data["snippet"]),
            score=float(data["score"]),
            document_id=_optional_str(data.get("document_id")),
            filename=_optional_str(data.get("filename")),
            page=_optional_str(data.get("page")),
            page_start=_optional_int(data.get("page_start")),
            page_end=_optional_int(data.get("page_end")),
            section_path=_optional_str(data.get("section_path")),
            table_id=_optional_str(data.get("table_id")),
            row_start=_optional_int(data.get("row_start")),
            row_end=_optional_int(data.get("row_end")),
            record_type=_optional_str(data.get("record_type")),
        )


@dataclass(frozen=True)
class RetrieveResponse:
    api_version: str
    trace_id: str
    query: str
    library_id: str
    citations: tuple[Citation, ...] = field(default_factory=tuple)
    refused: bool = False
    refuse_reason: Optional[str] = None
    retrieval_mode: str = ""

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> RetrieveResponse:
        citations = tuple(
            Citation.from_dict(item) for item in (data.get("citations") or [])
        )
        return cls(
            api_version=str(data["api_version"]),
            trace_id=str(data["trace_id"]),
            query=str(data["query"]),
            library_id=str(data["library_id"]),
            citations=citations,
            refused=bool(data.get("refused", False)),
            refuse_reason=_optional_str(data.get("refuse_reason")),
            retrieval_mode=str(data.get("retrieval_mode") or ""),
        )


@dataclass(frozen=True)
class AskResponse:
    api_version: str
    trace_id: str
    session_id: str
    question: str
    answer: str
    citations: tuple[Citation, ...] = field(default_factory=tuple)
    refused: bool = False
    refuse_reason: Optional[str] = None
    retrieval_mode: str = ""

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> AskResponse:
        citations = tuple(
            Citation.from_dict(item) for item in (data.get("citations") or [])
        )
        return cls(
            api_version=str(data["api_version"]),
            trace_id=str(data["trace_id"]),
            session_id=str(data["session_id"]),
            question=str(data["question"]),
            answer=str(data["answer"]),
            citations=citations,
            refused=bool(data.get("refused", False)),
            refuse_reason=_optional_str(data.get("refuse_reason")),
            retrieval_mode=str(data.get("retrieval_mode") or ""),
        )


def _optional_str(value: Any) -> Optional[str]:
    if value is None:
        return None
    return str(value)


def _optional_int(value: Any) -> Optional[int]:
    if value is None:
        return None
    return int(value)
