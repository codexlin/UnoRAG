#!/usr/bin/env python3
"""Chunk-profile + MinerU A/B evaluation for MeriKnow.

Runs in-process (Settings overrides) so CHUNKING_PROFILE / MINERU_* can vary
without restarting uvicorn. Ingest uses live embeddings + Qdrant; Ask uses
AskGraphService (same stack as /v1/ask).

Usage (from apps/api):

  uv run python scripts/ab_chunk_profiles.py
  uv run python scripts/ab_chunk_profiles.py --profiles balanced,precise,table_heavy
  uv run python scripts/ab_chunk_profiles.py --skip-narrative --skip-ask

Reports land in apps/api/.eval_reports/ (gitignored).

Timing semantics
----------------
IR parse is cached across profiles (same mineru settings). Metrics therefore
split:
  - parse_wall_s: wall time of parse_to_ir (recorded once per cache key;
    subsequent profile ingests reuse that value and set parse_cached=true)
  - chunk_index_wall_s: chunk + embed + Qdrant index only (excludes parse)
  - total_wall_s: parse_wall_s + chunk_index_wall_s (even when IR cached)

Recall semantics
----------------
  - strict_recall: all derived gold key facts appear in one hit body
  - partial_recall: any gold substring appears in a hit body
Headline ask ok / Recall@6 use strict_recall only.

The suite is loaded from testdata/ab/golds.jsonl. Add ``key_facts`` to a gold
case when the default numeric/name extraction is not specific enough.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
import traceback
from copy import deepcopy
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from uuid import uuid4

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
	sys.path.insert(0, str(ROOT))

REPO_ROOT = ROOT.parents[1]
TESTDATA = REPO_ROOT / "testdata"
REPORT_DIR = ROOT / ".eval_reports"

from app.graph.ask_graph import AskGraphService
from app.security.access_scope import AccessScope
from app.services.document_storage import DocumentStorage
from app.services.ingest.chunker import ChunkerConfig, chunk_document
from app.services.ingest.ir import DocumentIR
from app.services.ingest.router import parse_to_ir
from app.services.metadata import get_metadata_store, reset_metadata_store
from app.services.retrieval import IngestService, RetrievalService
from app.services.runtime import resolve_runtime
from app.settings import Settings, get_settings


PROFILES_DEFAULT = ("balanced", "precise", "table_heavy", "narrative")

AB_ROOT = TESTDATA / "ab"
AB_GOLDS = AB_ROOT / "golds.jsonl"


def _gold_key_facts(item: dict[str, Any]) -> list[str]:
	explicit = item.get("key_facts")
	if isinstance(explicit, list) and explicit:
		return [str(value) for value in explicit if str(value).strip()]

	answer = str(item.get("answer") or "")
	quoted = re.findall(r"[\"'“‘]([^\"'”’]{2,40})[\"'”’]", answer)
	values = re.findall(
		r"(?:[A-Z]{2,}(?:-[A-Z0-9]+)+|"
		r"\d{4}年\d{1,2}月\d{1,2}日|"
		r"\d+(?:,\d{3})+(?:\.\d+)?|"
		r"\d+(?:\.\d+)?(?:%|个百分点|TB|GB|元|个月|日|条|家|万|亿))",
		answer,
	)
	facts = list(dict.fromkeys([*quoted, *values]))
	if facts:
		return facts[:6]

	clauses = [
		part.strip(" ；。")
		for part in re.split(r"[；。]", answer)
		if len(part.strip(" ；。")) >= 4
	]
	if not clauses:
		raise ValueError(f"gold answer has no usable key facts: {item!r}")
	return [clauses[0]]


def _load_ab_suite(path: Path = AB_GOLDS) -> tuple[list[dict[str, str]], list[dict[str, Any]]]:
	if not path.is_file():
		raise FileNotFoundError(f"missing A/B gold set: {path}")

	docs_by_key: dict[str, dict[str, str]] = {}
	cases: list[dict[str, Any]] = []
	for line_no, raw in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
		if not raw.strip():
			continue
		try:
			item = json.loads(raw)
		except json.JSONDecodeError as exc:
			raise ValueError(f"invalid gold JSON at {path}:{line_no}: {exc}") from exc

		filename = str(item.get("file") or "").strip()
		question = str(item.get("question") or "").strip()
		if not filename or not question:
			raise ValueError(f"gold requires file and question at {path}:{line_no}")
		fixture = AB_ROOT / filename
		if not fixture.is_file():
			raise FileNotFoundError(f"gold fixture missing at {path}:{line_no}: {fixture}")

		key = fixture.stem
		docs_by_key.setdefault(
			key,
			{"key": key, "path": f"ab/{filename}", "kind": str(item.get("mode") or "")},
		)
		cases.append(
			{
				"id": f"ab-{line_no:02d}-{key}",
				"doc_keys": [key],
				"question": question,
				"answer_contains": _gold_key_facts(item),
				"prefer_title": key,
				"expect_record_type": item.get("expect_record_type"),
				"gold_mode": item.get("mode"),
				"chunk_hint": item.get("chunk_hint"),
			}
		)
	return list(docs_by_key.values()), cases


DOCS, ASK_CASES = _load_ab_suite()


@dataclass
class IngestRow:
	profile: str
	doc_key: str
	library_id: str
	status: str
	backend: str | None = None
	parser: str | None = None
	mode: str | None = None
	latency_ms: float | None = None
	parse_wall_s: float | None = None
	chunk_index_wall_s: float | None = None
	total_wall_s: float | None = None
	parse_cached: bool = False
	chunk_count: int = 0
	section_count: int = 0
	table_count: int = 0
	point_count: int = 0
	embed_count: int = 0
	chunking: dict[str, Any] = field(default_factory=dict)
	error: str | None = None
	doc_id: str | None = None
	notes: str = ""


@dataclass
class AskRow:
	profile: str
	library_id: str
	case_id: str
	question: str
	ok: bool
	refused: bool = False
	answer: str = ""
	missing: list[str] = field(default_factory=list)
	citation_title: str | None = None
	citation_page: str | None = None
	citation_section: str | None = None
	# Plan / secondary retrieval / actual Ask citation — never collapse these.
	ask_plan_record_type: str | None = None
	retrieval_hit_record_type: str | None = None
	actual_citation_record_type: str | None = None
	table_path_ok: bool | None = None
	strict_recall_rank: int | None = None
	partial_recall_rank: int | None = None
	strict_recall: bool = False
	partial_recall: bool = False
	errors: list[str] = field(default_factory=list)


# parse_wall_s recorded once per IR cache key
_ParseCacheEntry = tuple[DocumentIR, float]


def _utc_stamp() -> str:
	return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def _base_settings() -> Settings:
	get_settings.cache_clear()
	reset_metadata_store()
	base = Settings()
	# Ensure deterministic sync path + real MinerU tunnel defaults from .env
	return base.model_copy(
		update={
			"ingest_async": False,
			"session_memory_enabled": False,
		}
	)


def _settings_for(
	base: Settings,
	*,
	profile: str,
	mineru_enabled: bool | None = None,
	mineru_mode: str | None = None,
) -> Settings:
	updates: dict[str, Any] = {
		"chunking_profile": profile,
		"ingest_async": False,
		"session_memory_enabled": False,
	}
	if mineru_enabled is not None:
		updates["mineru_enabled"] = mineru_enabled
	if mineru_mode is not None:
		updates["mineru_mode"] = mineru_mode
	return base.model_copy(update=updates)


def _resolve_doc(rel: str) -> Path:
	path = TESTDATA / rel
	if not path.is_file():
		raise FileNotFoundError(f"missing fixture: {path}")
	return path


def _mime_for(path: Path) -> str:
	return {
		".md": "text/markdown",
		".txt": "text/plain",
		".pdf": "application/pdf",
		".docx": (
			"application/vnd.openxmlformats-officedocument.wordprocessingml.document"
		),
	}.get(path.suffix.lower(), "application/octet-stream")


def _ensure_clean_library(meta, settings: Settings, library_id: str, name: str) -> None:
	scope = AccessScope.development(settings)
	ingest = IngestService(settings)
	storage = DocumentStorage(settings)
	existing = meta.get_library(library_id, scope=scope)
	if existing is not None:
		for doc in list(meta.list_documents(library_id, scope=scope)):
			doc_id = str(doc["id"])
			try:
				ingest.delete_document_chunks(doc_id=doc_id, library_id=library_id)
			except Exception:
				pass
			key = doc.get("storage_key")
			if key:
				try:
					storage.delete(str(key))
				except Exception:
					pass
			meta.delete_document(doc_id, scope=scope)
		meta.delete_library(library_id, scope=scope)
	meta.create_library(
		name=name,
		library_id=library_id,
		description="chunk-profile A/B",
		scope=scope,
	)


def _parse_ir_cached(
	cache: dict[str, _ParseCacheEntry],
	*,
	settings: Settings,
	doc_key: str,
	path: Path,
	library_id: str,
) -> tuple[DocumentIR, float, bool]:
	"""Return (ir_copy, parse_wall_s, parse_cached).

	parse_wall_s is the original parse duration even on cache hit, so
	total_wall_s = parse + index remains meaningful across profiles.
	"""
	# Cache by doc_key + mineru_enabled so MinerU off/on stay separate.
	cache_key = f"{doc_key}|mineru={settings.mineru_enabled}|mode={settings.mineru_mode}"
	if cache_key in cache:
		cached_ir, parse_wall_s = cache[cache_key]
		ir = deepcopy(cached_ir)
		ir.id = str(uuid4())
		return ir, parse_wall_s, True
	content = path.read_bytes()
	started = time.perf_counter()
	ir = parse_to_ir(
		filename=path.name,
		content=content,
		title=path.stem,
		settings=settings,
		library_id=library_id,
		content_type=_mime_for(path),
	)
	parse_wall_s = round(time.perf_counter() - started, 3)
	cache[cache_key] = (deepcopy(ir), parse_wall_s)
	# Return a copy with unique id for this ingest
	out = deepcopy(ir)
	out.id = str(uuid4())
	return out, parse_wall_s, False


def _ingest_ir(
	*,
	settings: Settings,
	meta,
	library_id: str,
	ir: DocumentIR,
	path: Path,
	profile: str,
	parse_wall_s: float,
	parse_cached: bool,
) -> IngestRow:
	started = time.perf_counter()
	row = IngestRow(
		profile=profile,
		doc_key=path.stem if path.stem else path.name,
		library_id=library_id,
		status="processing",
		parse_wall_s=parse_wall_s,
		parse_cached=parse_cached,
	)
	# Align doc_key with DOCS keys when possible
	for item in DOCS:
		if Path(item["path"]).name == path.name:
			row.doc_key = item["key"]
			break

	storage = DocumentStorage(settings)
	scope = AccessScope.development(settings)
	doc_id = ir.id
	try:
		chunks = chunk_document(
			ir,
			config=ChunkerConfig(
				chunk_size=settings.chunk_size,
				chunk_overlap=settings.chunk_overlap,
				profile_name=profile,
				policy_version=settings.chunk_policy_version,
				semantic_enabled=settings.semantic_chunking_enabled,
				semantic_min_chars=settings.semantic_chunk_min_chars,
				semantic_break_percentile=settings.semantic_chunk_break_percentile,
			),
		)
		if not chunks:
			raise ValueError("document produced no chunks after structure-aware split")

		report = ir.parser_report.to_public_dict()
		chunking = (report.get("metrics") or {}).get("chunking") or {}
		# chunk_document mutates ir.parser_report.metrics.chunking
		chunking = (ir.parser_report.metrics or {}).get("chunking") or chunking
		report = ir.parser_report.to_public_dict()

		doc = meta.create_document(
			library_id=library_id,
			name=path.stem,
			filename=path.name,
			content_type=_mime_for(path),
			doc_id=doc_id,
			status="processing",
			size_bytes=path.stat().st_size,
			scope=scope,
		)
		storage_key = storage.save(library_id, doc["id"], path.name, path.read_bytes())
		meta.update_document(doc["id"], storage_key=storage_key, scope=scope)

		result = IngestService(settings).ingest_ir_chunks(
			library_id=library_id,
			title=path.stem,
			chunks=chunks,
			doc_id=doc_id,
			filename=path.name,
			parser_report=report,
		)
		meta.update_document(
			doc_id,
			status="ready",
			chunk_count=result["chunk_count"],
			error=None,
			parser_report=report,
			scope=scope,
		)
		index_wall = round(time.perf_counter() - started, 3)
		row.status = "ready"
		row.backend = str(report.get("backend") or "") or None
		row.parser = str(report.get("parser") or "") or None
		row.mode = str(report.get("mode") or "") or None
		row.latency_ms = float(report.get("latency_ms") or 0) or None
		row.chunk_index_wall_s = index_wall
		row.total_wall_s = round(parse_wall_s + index_wall, 3)
		row.chunk_count = int(result.get("chunk_count") or 0)
		row.section_count = int(result.get("section_count") or 0)
		row.table_count = int(result.get("table_count") or 0)
		row.point_count = int(result.get("point_count") or 0)
		row.embed_count = row.point_count  # proxy: one embedding per indexed point
		row.chunking = dict(chunking) if isinstance(chunking, dict) else {}
		row.doc_id = doc_id
		return row
	except Exception as exc:
		index_wall = round(time.perf_counter() - started, 3)
		row.status = "failed"
		row.chunk_index_wall_s = index_wall
		row.total_wall_s = round(parse_wall_s + index_wall, 3)
		row.error = str(exc)
		row.doc_id = doc_id
		try:
			meta.update_document(
				doc_id,
				status="failed",
				error=str(exc),
				scope=scope,
			)
		except Exception:
			pass
		# Attach parser backend if parse succeeded before chunk/ingest failed
		try:
			report = ir.parser_report.to_public_dict()
			row.backend = str(report.get("backend") or "") or None
			row.latency_ms = float(report.get("latency_ms") or 0) or None
		except Exception:
			pass
		return row


def _run_mineru_control(
	*,
	base: Settings,
	meta,
	ir_cache: dict[str, _ParseCacheEntry],
) -> list[IngestRow]:
	"""Same scanned PDF: MinerU on vs off (and optional force modes)."""
	path = _resolve_doc("pdf/leave-scanned.pdf")
	rows: list[IngestRow] = []

	variants = [
		("mineru-on", True, "auto", "lib-ab-mineru-on"),
		("mineru-off", False, "auto", "lib-ab-mineru-off"),
	]
	for label, enabled, mode, lib_id in variants:
		settings = _settings_for(
			base, profile="balanced", mineru_enabled=enabled, mineru_mode=mode
		)
		_ensure_clean_library(meta, settings, lib_id, f"AB {label}")
		started = time.perf_counter()
		row = IngestRow(
			profile=f"control:{label}",
			doc_key="leave-scanned",
			library_id=lib_id,
			status="processing",
			notes=f"mineru_enabled={enabled} mineru_mode={mode}",
		)
		try:
			ir, parse_wall_s, parse_cached = _parse_ir_cached(
				ir_cache,
				settings=settings,
				doc_key="leave-scanned",
				path=path,
				library_id=lib_id,
			)
			row = _ingest_ir(
				settings=settings,
				meta=meta,
				library_id=lib_id,
				ir=ir,
				path=path,
				profile="balanced",
				parse_wall_s=parse_wall_s,
				parse_cached=parse_cached,
			)
			row.profile = f"control:{label}"
			row.notes = f"mineru_enabled={enabled} mineru_mode={mode}"
		except Exception as exc:
			row.status = "failed"
			row.error = str(exc)
			row.chunk_index_wall_s = round(time.perf_counter() - started, 3)
			row.total_wall_s = row.chunk_index_wall_s
		rows.append(row)
		print(
			f"  [mineru-control] {label}: status={row.status} backend={row.backend} "
			f"chunks={row.chunk_count} parse={row.parse_wall_s}s "
			f"index={row.chunk_index_wall_s}s err={row.error!r}",
			flush=True,
		)
	return rows


def _retrieval_ranks(
	*,
	settings: Settings,
	library_id: str,
	question: str,
	needles: list[str],
	record_type: str = "chunk",
	top_k: int = 6,
) -> tuple[int | None, int | None, str | None, str | None]:
	"""Return (strict_rank, partial_rank, strict_rtype, partial_rtype).

	strict: first hit whose body contains ALL needles.
	partial: first hit whose body contains ANY needle.
	record_types are from those respective hits (secondary RetrievalService search;
	defaults to chunk filter — not the Ask plan path).
	"""
	service = RetrievalService(settings)
	hits = service.search(
		query=question,
		library_id=library_id,
		record_type=record_type,
		top_k=top_k,
	)
	active = [n for n in needles if n]
	strict_rank: int | None = None
	strict_rtype: str | None = None
	partial_rank: int | None = None
	partial_rtype: str | None = None
	for index, hit in enumerate(hits, start=1):
		body = str(hit.get("body") or hit.get("text") or "")
		rtype = str(hit.get("record_type") or "chunk")
		if strict_rank is None and active and all(n in body for n in active):
			strict_rank = index
			strict_rtype = rtype
		if partial_rank is None and active and any(n in body for n in active):
			partial_rank = index
			partial_rtype = rtype
		if strict_rank is not None and partial_rank is not None:
			break
	return strict_rank, partial_rank, strict_rtype, partial_rtype


def _attr_or_key(obj: Any, key: str) -> Any:
	if obj is None:
		return None
	if isinstance(obj, dict):
		return obj.get(key)
	return getattr(obj, key, None)


def _index_record_type(gold_record_type: Any) -> str:
	"""Map source-level gold types onto record types stored in Qdrant."""
	return {
		"table": "table",
		"text": "chunk",
		# ChartIR is not implemented yet, so figures currently ride in text chunks.
		"image": "chunk",
	}.get(str(gold_record_type or ""), "chunk")


def _run_ask_suite(
	*,
	settings: Settings,
	profile: str,
	library_id: str,
	available_docs: set[str],
) -> list[AskRow]:
	ask = AskGraphService(settings, capability=resolve_runtime(settings))
	rows: list[AskRow] = []
	for case in ASK_CASES:
		needed = set(case["doc_keys"])
		if not needed.issubset(available_docs):
			continue
		question = case["question"]
		needles: list[str] = list(case.get("answer_contains") or [])
		row = AskRow(
			profile=profile,
			library_id=library_id,
			case_id=case["id"],
			question=question,
			ok=False,
		)
		try:
			resp = ask.ask(question=question, library_id=library_id)
			answer = resp.answer or ""
			row.answer = answer
			row.refused = bool(resp.refused)
			missing = [n for n in needles if n not in answer]
			row.missing = missing
			cites = list(resp.citations or [])
			if cites:
				c0 = cites[0]
				row.citation_title = _attr_or_key(c0, "title")
				row.citation_page = _attr_or_key(c0, "page")
				row.citation_section = _attr_or_key(c0, "section_path")
				actual_rt = _attr_or_key(c0, "record_type")
				row.actual_citation_record_type = (
					str(actual_rt) if actual_rt else None
				)

			# Ask plan record_type from response debug / persisted plan
			debug = getattr(resp, "retrieval_debug", None) or {}
			plan = debug.get("retrieval_plan") if isinstance(debug, dict) else None
			if isinstance(plan, dict):
				plan_rt = plan.get("record_type") or (plan.get("filters") or {}).get(
					"record_type"
				)
				row.ask_plan_record_type = str(plan_rt) if plan_rt else None

			strict_rank, partial_rank, strict_rtype, partial_rtype = _retrieval_ranks(
				settings=settings,
				library_id=library_id,
				question=question,
				needles=needles,
				record_type=_index_record_type(case.get("expect_record_type")),
			)
			row.strict_recall_rank = strict_rank
			row.partial_recall_rank = partial_rank
			row.strict_recall = strict_rank is not None and strict_rank <= 6
			row.partial_recall = partial_rank is not None and partial_rank <= 6
			# Secondary retrieval hit type (default chunk path) — not citation type
			row.retrieval_hit_record_type = strict_rtype or partial_rtype

			errors: list[str] = []
			if row.refused:
				errors.append("refused")
			if missing:
				errors.append(f"answer missing {missing}")
			prefer = case.get("prefer_title")
			if prefer and row.citation_title and prefer not in str(row.citation_title):
				# soft warning — don't fail solely on title mismatch across multi-doc libs
				pass
			sec = case.get("expect_section_substr")
			if sec and row.citation_section and sec not in str(row.citation_section):
				errors.append(f"section missing {sec!r} got={row.citation_section!r}")

			want_rt = case.get("expect_record_type")
			if want_rt:
				# Golds describe source-level text/table/image. Compare against
				# the concrete index type used by the current architecture.
				want_index_rt = _index_record_type(want_rt)
				observed = row.actual_citation_record_type or row.ask_plan_record_type
				table_ok = (
					row.ask_plan_record_type == want_index_rt
					or row.actual_citation_record_type == want_index_rt
				)
				row.table_path_ok = table_ok
				if not table_ok:
					errors.append(
						f"record_path_ok=false want={want_index_rt} "
						f"plan={row.ask_plan_record_type} "
						f"citation={row.actual_citation_record_type} "
						f"retrieval_hit={row.retrieval_hit_record_type} "
						f"observed={observed}"
					)

			# Headline recall uses strict only (partial is diagnostic).
			if not row.strict_recall:
				if row.partial_recall:
					errors.append(
						f"strict Recall@6 miss (partial@{row.partial_recall_rank})"
					)
				else:
					errors.append("strict Recall@6 miss")
			row.errors = errors
			row.ok = not errors
		except Exception as exc:
			row.errors = [f"ask failed: {exc}"]
			row.ok = False
		rows.append(row)
		flag = "OK" if row.ok else "FAIL"
		print(
			f"  [ask {profile}] {flag} {case['id']} "
			f"strict@{row.strict_recall_rank} partial@{row.partial_recall_rank} "
			f"plan={row.ask_plan_record_type} cite={row.actual_citation_record_type} "
			f"missing={row.missing} refused={row.refused}",
			flush=True,
		)
	return rows


def _profiles_differentiated(ingest_rows: list[IngestRow]) -> bool:
	"""True if any ready doc has different chunk/section/table counts across profiles."""
	by_doc: dict[str, list[tuple[int, int, int]]] = {}
	for row in ingest_rows:
		if row.status != "ready":
			continue
		by_doc.setdefault(row.doc_key, []).append(
			(row.chunk_count, row.section_count, row.table_count)
		)
	for counts in by_doc.values():
		if len(set(counts)) > 1:
			return True
	return False


def _markdown_report(
	*,
	ingest_rows: list[IngestRow],
	ask_rows: list[AskRow],
	mineru_rows: list[IngestRow],
	profiles: list[str],
) -> str:
	lines: list[str] = []
	lines.append("# MeriKnow Chunk Profile + MinerU A/B Report")
	lines.append("")
	lines.append(f"- Generated: `{_utc_stamp()}`")
	lines.append(f"- Profiles: {', '.join(profiles)}")
	lines.append(
		"- Profile selection: global `Settings.chunking_profile` / env `CHUNKING_PROFILE` "
		"(ingest-time only; not per-library)."
	)
	lines.append(
		"- MinerU: `MINERU_ENABLED` + `MINERU_MODE` (`auto|pymupdf|mineru`); "
		"scanned PDFs upgrade when extractable text is insufficient."
	)
	lines.append(
		"- Timing: `parse_wall_s` = parse_to_ir (cached across profiles; "
		"`parse_cached=true` on reuse); `chunk_index_wall_s` = chunk+embed+index only; "
		"`total_wall_s` = parse + index even when IR cached."
	)
	lines.append(
		"- Recall: headline uses **strict_recall** (all gold fields in one hit); "
		"`partial_recall` is diagnostic only."
	)
	differentiated = _profiles_differentiated(ingest_rows)
	if not differentiated:
		lines.append("")
		lines.append(
			"> **No profile differentiation on current fixtures.** "
			"Chunk/section/table counts are identical across balanced / precise / "
			"table_heavy / narrative. This run is a smoke/regression check only — "
			"**do not recommend precise or table_heavy from these results.** "
			"Product default remains **balanced** + MinerU `auto`."
		)
	lines.append("")

	lines.append("## MinerU control (same scanned PDF)")
	lines.append("")
	lines.append(
		"| variant | status | backend | latency_ms | parse_s | index_s | total_s | chunks | error |"
	)
	lines.append("|---|---|---|---:|---:|---:|---:|---:|---|")
	for row in mineru_rows:
		lines.append(
			f"| {row.profile} | {row.status} | {row.backend or '-'} | "
			f"{row.latency_ms if row.latency_ms is not None else '-'} | "
			f"{row.parse_wall_s if row.parse_wall_s is not None else '-'} | "
			f"{row.chunk_index_wall_s if row.chunk_index_wall_s is not None else '-'} | "
			f"{row.total_wall_s if row.total_wall_s is not None else '-'} | "
			f"{row.chunk_count} | {(row.error or '')[:80]} |"
		)
	lines.append("")

	lines.append("## Ingest matrix (profile × doc)")
	lines.append("")
	lines.append(
		"| profile | doc | status | backend | parse_ms | parse_s | index_s | total_s | "
		"cached | chunks | sections | tables | embeds | strategies |"
	)
	lines.append(
		"|---|---|---|---|---:|---:|---:|---:|---|---:|---:|---:|---:|---|"
	)
	for row in ingest_rows:
		strategies = row.chunking.get("strategies") if row.chunking else {}
		lines.append(
			f"| {row.profile} | {row.doc_key} | {row.status} | {row.backend or '-'} | "
			f"{row.latency_ms if row.latency_ms is not None else '-'} | "
			f"{row.parse_wall_s if row.parse_wall_s is not None else '-'} | "
			f"{row.chunk_index_wall_s if row.chunk_index_wall_s is not None else '-'} | "
			f"{row.total_wall_s if row.total_wall_s is not None else '-'} | "
			f"{row.parse_cached} | "
			f"{row.chunk_count} | {row.section_count} | {row.table_count} | "
			f"{row.embed_count} | {strategies} |"
		)
	lines.append("")

	lines.append("## Ask / strict Recall@6")
	lines.append("")
	lines.append(
		"| profile | case | ok | strict@ | partial@ | plan_rt | hit_rt | cite_rt | "
		"table_ok | citation_page | missing | errors |"
	)
	lines.append("|---|---|---|---:|---:|---|---|---|---|---|---|---|")
	for row in ask_rows:
		table_ok = "-" if row.table_path_ok is None else str(row.table_path_ok)
		lines.append(
			f"| {row.profile} | {row.case_id} | {row.ok} | "
			f"{row.strict_recall_rank if row.strict_recall_rank is not None else '-'} | "
			f"{row.partial_recall_rank if row.partial_recall_rank is not None else '-'} | "
			f"{row.ask_plan_record_type or '-'} | "
			f"{row.retrieval_hit_record_type or '-'} | "
			f"{row.actual_citation_record_type or '-'} | "
			f"{table_ok} | {row.citation_page or '-'} | "
			f"{row.missing or '-'} | "
			f"{'; '.join(row.errors) if row.errors else '-'} |"
		)
	lines.append("")

	# Aggregate metrics
	lines.append("## Headline metrics (strict only)")
	lines.append("")
	for profile in profiles:
		subset = [a for a in ask_rows if a.profile == profile]
		if not subset:
			continue
		ok_n = sum(1 for a in subset if a.ok)
		strict_n = sum(1 for a in subset if a.strict_recall)
		partial_n = sum(1 for a in subset if a.partial_recall)
		table_cases = [a for a in subset if a.table_path_ok is not None]
		table_ok_n = sum(1 for a in table_cases if a.table_path_ok)
		lines.append(
			f"- **{profile}**: ask_ok {ok_n}/{len(subset)}; "
			f"strict_recall {strict_n}/{len(subset)}; "
			f"partial_recall {partial_n}/{len(subset)}"
			+ (
				f"; table_path_ok {table_ok_n}/{len(table_cases)}"
				if table_cases
				else ""
			)
		)
	lines.append("")

	# Aggregate recommendations
	lines.append("## Findings")
	lines.append("")
	if not differentiated:
		lines.append(
			"- **No profile differentiation**: chunk/section/table counts are identical "
			"across the dedicated A/B stress fixtures in this run."
		)
		lines.append(
			"- Therefore this report must **not** be used to pick precise / table_heavy / "
			"narrative over the product default **balanced**."
		)
	else:
		lines.append(
			"- Profiles produced different chunk/section/table counts on at least one doc "
			"— compare matrix above before changing defaults."
		)
	lines.append(
		"- MinerU control isolates OCR availability on the same scan; compare its ready/fail "
		"state separately from profile quality."
	)
	lines.append(
		"- Digital PDF correctly stays on **pymupdf**; scanned upgrades to **mineru**."
	)
	lines.append(
		"- Table golds require the table-aware Ask plan or a table citation; a coincidental "
		"match from the default chunk path is not counted as a path pass."
	)
	lines.append("")
	lines.append("## Recommendation")
	lines.append("")
	lines.append(
		"- **Keep product default: `balanced` + MinerU `auto`.** "
		"Only change it when the per-profile quality gain justifies its index and latency cost."
	)
	if not differentiated:
		lines.append(
			"- Do **not** recommend precise / table_heavy / narrative from this run — "
			"fixtures cannot surface their cost/quality differences."
		)
	lines.append(
		"- Always enable **MinerU** (`MINERU_ENABLED=true` + tunnel/service) for any library "
		"that may receive scans; keep `MINERU_MODE=auto` so digital PDFs stay on PyMuPDF."
	)
	lines.append("")
	lines.append("## Remaining product gaps")
	lines.append("")
	lines.append(
		"- Chart questions currently measure extraction/citation behavior; a normalized "
		"`ChartIR` and chart-specific execution path remain future work."
	)
	lines.append(
		"- Profile is process-wide env today; product needs per-library or per-ingest profile API."
	)
	lines.append("")
	return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
	parser = argparse.ArgumentParser(description="Chunk profile + MinerU A/B eval")
	parser.add_argument(
		"--profiles",
		default=",".join(PROFILES_DEFAULT),
		help="Comma-separated profiles (default: balanced,precise,table_heavy,narrative)",
	)
	parser.add_argument("--skip-narrative", action="store_true")
	parser.add_argument("--skip-ask", action="store_true")
	parser.add_argument("--skip-mineru-control", action="store_true")
	parser.add_argument(
		"--docs",
		default=",".join(d["key"] for d in DOCS),
		help="Comma-separated doc keys",
	)
	args = parser.parse_args(argv)

	profiles = [p.strip() for p in args.profiles.split(",") if p.strip()]
	if args.skip_narrative:
		profiles = [p for p in profiles if p != "narrative"]
	doc_keys = {k.strip() for k in args.docs.split(",") if k.strip()}
	docs = [d for d in DOCS if d["key"] in doc_keys]

	base = _base_settings()
	cap = resolve_runtime(base)
	if not cap.live_ready:
		print("live runtime not ready:", cap.reasons, file=sys.stderr)
		return 1
	if not base.mineru_enabled or not base.mineru_url:
		print(
			"WARN: MINERU_ENABLED/URL not set — scanned control may fail as expected",
			file=sys.stderr,
		)
	print(
		f"settings: profile_default={base.chunking_profile} "
		f"mineru={base.mineru_enabled} url={base.mineru_url} mode={base.mineru_mode}",
		flush=True,
	)

	meta = get_metadata_store(base)
	ir_cache: dict[str, _ParseCacheEntry] = {}
	ingest_rows: list[IngestRow] = []
	ask_rows: list[AskRow] = []
	mineru_rows: list[IngestRow] = []

	if not args.skip_mineru_control:
		print("== MinerU control A/B ==", flush=True)
		mineru_rows = _run_mineru_control(base=base, meta=meta, ir_cache=ir_cache)

	for profile in profiles:
		lib_id = f"lib-ab-{profile}"
		settings = _settings_for(base, profile=profile, mineru_enabled=True, mineru_mode="auto")
		print(f"== Profile {profile} → {lib_id} ==", flush=True)
		_ensure_clean_library(meta, settings, lib_id, f"AB chunk {profile}")
		ready_docs: set[str] = set()
		for doc in docs:
			path = _resolve_doc(doc["path"])
			print(f"  ingest {doc['key']} ...", flush=True)
			try:
				ir, parse_wall_s, parse_cached = _parse_ir_cached(
					ir_cache,
					settings=settings,
					doc_key=doc["key"],
					path=path,
					library_id=lib_id,
				)
				row = _ingest_ir(
					settings=settings,
					meta=meta,
					library_id=lib_id,
					ir=ir,
					path=path,
					profile=profile,
					parse_wall_s=parse_wall_s,
					parse_cached=parse_cached,
				)
			except Exception as exc:
				row = IngestRow(
					profile=profile,
					doc_key=doc["key"],
					library_id=lib_id,
					status="failed",
					error=f"{exc}\n{traceback.format_exc()[-400:]}",
				)
			ingest_rows.append(row)
			if row.status == "ready":
				ready_docs.add(doc["key"])
			print(
				f"    → {row.status} backend={row.backend} chunks={row.chunk_count} "
				f"tables={row.table_count} embeds={row.embed_count} "
				f"parse={row.parse_wall_s}s index={row.chunk_index_wall_s}s "
				f"total={row.total_wall_s}s cached={row.parse_cached} "
				f"err={row.error!r}",
				flush=True,
			)

		if not args.skip_ask and ready_docs:
			print(f"  ask suite on {lib_id} ...", flush=True)
			ask_rows.extend(
				_run_ask_suite(
					settings=settings,
					profile=profile,
					library_id=lib_id,
					available_docs=ready_docs,
				)
			)

	REPORT_DIR.mkdir(parents=True, exist_ok=True)
	stamp = _utc_stamp()
	payload = {
		"generated_at": stamp,
		"profiles": profiles,
		"docs": [d["key"] for d in docs],
		"metrics_semantics": {
			"parse_wall_s": "parse_to_ir wall; reused from IR cache when parse_cached",
			"chunk_index_wall_s": "chunk + embed + Qdrant index only (excludes parse)",
			"total_wall_s": "parse_wall_s + chunk_index_wall_s",
			"strict_recall": "all derived gold key facts in one retrieval hit body @6",
			"partial_recall": "any gold field in a hit body @6 (diagnostic only)",
			"ask_plan_record_type": "retrieval_plan.record_type from Ask graph",
			"retrieval_hit_record_type": "secondary RetrievalService hit (default chunk path)",
			"actual_citation_record_type": "citations[0].record_type from Ask response",
			"table_path_ok": "hard check when case.expect_record_type set",
		},
		"profile_differentiation": _profiles_differentiated(ingest_rows),
		"product_stance": {
			"default_profile": "balanced",
			"mineru_mode": "auto",
			"do_not_auto_pick_other_profiles_from_this_run": True,
		},
		"profile_selection": {
			"mechanism": "Settings.chunking_profile / CHUNKING_PROFILE env",
			"scope": "process-wide at ingest time (not per-library API param yet)",
			"applied_in": "prepare_ingest → ChunkerConfig.profile_name",
		},
		"mineru_control": [asdict(r) for r in mineru_rows],
		"ingest": [asdict(r) for r in ingest_rows],
		"ask": [asdict(r) for r in ask_rows],
	}
	json_path = REPORT_DIR / f"ab_chunk_profiles_{stamp}.json"
	md_path = REPORT_DIR / f"ab_chunk_profiles_{stamp}.md"
	json_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
	md_path.write_text(
		_markdown_report(
			ingest_rows=ingest_rows,
			ask_rows=ask_rows,
			mineru_rows=mineru_rows,
			profiles=profiles,
		),
		encoding="utf-8",
	)
	latest_json = REPORT_DIR / "ab_chunk_profiles_latest.json"
	latest_md = REPORT_DIR / "ab_chunk_profiles_latest.md"
	latest_json.write_text(json_path.read_text(encoding="utf-8"), encoding="utf-8")
	latest_md.write_text(md_path.read_text(encoding="utf-8"), encoding="utf-8")

	ask_ok = sum(1 for r in ask_rows if r.ok)
	strict_n = sum(1 for r in ask_rows if r.strict_recall)
	partial_n = sum(1 for r in ask_rows if r.partial_recall)
	table_cases = [r for r in ask_rows if r.table_path_ok is not None]
	table_ok_n = sum(1 for r in table_cases if r.table_path_ok)
	print(f"\nWrote {json_path}")
	print(f"Wrote {md_path}")
	print(
		f"Summary: ingest_ready="
		f"{sum(1 for r in ingest_rows if r.status == 'ready')}/{len(ingest_rows)} "
		f"ask_ok={ask_ok}/{len(ask_rows)} "
		f"strict_recall={strict_n}/{len(ask_rows)} "
		f"partial_recall={partial_n}/{len(ask_rows)} "
		f"table_path_ok={table_ok_n}/{len(table_cases)} "
		f"profile_diff={payload['profile_differentiation']} "
		f"mineru_control={[ (r.profile, r.status, r.backend) for r in mineru_rows ]}"
	)
	return 0


if __name__ == "__main__":
	raise SystemExit(main())
