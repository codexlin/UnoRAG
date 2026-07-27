"""Business-intent policy profiles → internal ask/ingest knobs.

Public contract (stable): answer_profile, retrieval_enhancement,
session_memory_enabled, evidence_requirement, document_profile,
scan_handling, parse_preference.

Internal knobs (retrieve_top_k, RRF_K, chunk sizes, Provider URL/Key, …)
are resolved here / at deploy time only — never exposed as free-form
product settings.

Conflict rule (refusal/citation):
  Take the *stricter* of answer_profile and evidence_requirement.
  Stricter = higher answer_min_score, higher citation floor, adjudicate=true preferred.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any

from app.services.ask_defaults import ASK_DEFAULTS, ASK_OVERRIDE_KEYS

ANSWER_PROFILES = ("precise", "balanced", "exploratory")
RETRIEVAL_ENHANCEMENTS = ("auto", "off", "on")
EVIDENCE_REQUIREMENTS = ("strict", "standard", "relaxed")
DOCUMENT_PROFILES = (
	"auto",
	"general",
	"narrative",
	"table_heavy",
	"regulatory",
	"precise_paragraph",
)
SCAN_HANDLINGS = ("auto", "disabled", "force_ocr")
# Library/user parse intent — never selects self_hosted vs 302ai.
PARSE_PREFERENCES = ("auto", "quality", "local_only")

# Public keys stored in workspace_settings.ask
ASK_PUBLIC_KEYS = (
	"answer_profile",
	"retrieval_enhancement",
	"session_memory_enabled",
	"evidence_requirement",
)

# Keys that uniquely identify the public contract (session_memory is shared with legacy).
ASK_PUBLIC_PROFILE_KEYS = (
	"answer_profile",
	"retrieval_enhancement",
	"evidence_requirement",
)

# Legacy knobs still accepted for one release / ask_overrides inject.
ASK_LEGACY_KEYS = ASK_OVERRIDE_KEYS

PUBLIC_ASK_DEFAULTS: dict[str, Any] = {
	"answer_profile": "balanced",
	"retrieval_enhancement": "auto",
	"session_memory_enabled": True,
	"evidence_requirement": "standard",
}

# answer_profile → base internals (tuned to current ASK_DEFAULTS for balanced).
_ANSWER_PROFILE_BASE: dict[str, dict[str, Any]] = {
	# higher bar; refuse when weak evidence
	"precise": {
		"retrieve_top_k": 4,
		"answer_min_score": 0.55,
		"citation_adjudicate_enabled": True,
		"citation_adjudicate_absolute_floor": 0.45,
	},
	# current product defaults
	"balanced": {
		"retrieve_top_k": ASK_DEFAULTS.retrieve_top_k,  # 6
		"answer_min_score": ASK_DEFAULTS.answer_min_score,  # 0.4
		"citation_adjudicate_enabled": ASK_DEFAULTS.citation_adjudicate_enabled,
		"citation_adjudicate_absolute_floor": ASK_DEFAULTS.citation_adjudicate_absolute_floor,
	},
	# wider recall; allow related clues
	"exploratory": {
		"retrieve_top_k": 10,
		"answer_min_score": 0.25,
		"citation_adjudicate_enabled": True,
		"citation_adjudicate_absolute_floor": 0.25,
	},
}

# evidence_requirement → refusal floors (stricter wins vs profile).
# requires_adjudicate: True forces adjudicate on; False = no force.
_EVIDENCE_FLOORS: dict[str, dict[str, Any]] = {
	"strict": {
		"min_score_floor": 0.5,
		"absolute_floor": 0.4,
		"requires_adjudicate": True,
	},
	"standard": {
		"min_score_floor": 0.0,
		"absolute_floor": 0.0,
		"requires_adjudicate": False,
	},
	"relaxed": {
		"min_score_floor": 0.0,
		"absolute_floor": 0.0,
		"requires_adjudicate": False,
		# Soften profile bars slightly; still subject to max() with floors above.
		"min_score_delta": -0.1,
		"absolute_floor_delta": -0.05,
	},
}

# document_profile (public) → internal chunking_profile name (+ semantic hint).
# Internal engine profiles: precise | balanced | narrative | table_heavy
_DOCUMENT_PROFILE_MAP: dict[str, dict[str, Any]] = {
	"auto": {"chunk_profile": "balanced", "semantic_enabled": None},
	"general": {"chunk_profile": "balanced", "semantic_enabled": False},
	"narrative": {"chunk_profile": "narrative", "semantic_enabled": True},
	"table_heavy": {"chunk_profile": "table_heavy", "semantic_enabled": False},
	"regulatory": {"chunk_profile": "precise", "semantic_enabled": False},
	"precise_paragraph": {"chunk_profile": "precise", "semantic_enabled": False},
}


@dataclass(frozen=True, slots=True)
class ResolvedAskPolicy:
	"""Resolved ask knobs + public snapshot for traces."""

	public: dict[str, Any]
	retrieve_top_k: int
	answer_min_score: float
	hybrid_enabled: bool
	rerank_enabled: bool
	citation_adjudicate_enabled: bool
	citation_adjudicate_absolute_floor: float
	session_memory_enabled: bool
	session_memory_max_turns: int
	retrieval_enhancement_resolved_from: str  # auto|off|on after resolve
	policy_version: int | None = None

	def as_override_knobs(self) -> dict[str, Any]:
		return {
			"retrieve_top_k": self.retrieve_top_k,
			"answer_min_score": self.answer_min_score,
			"hybrid_enabled": self.hybrid_enabled,
			"rerank_enabled": self.rerank_enabled,
			"citation_adjudicate_enabled": self.citation_adjudicate_enabled,
			"citation_adjudicate_absolute_floor": self.citation_adjudicate_absolute_floor,
			"session_memory_enabled": self.session_memory_enabled,
			"session_memory_max_turns": self.session_memory_max_turns,
		}

	def snapshot(self) -> dict[str, Any]:
		return {
			"public": dict(self.public),
			"resolved": self.as_override_knobs(),
			"retrieval_enhancement": self.retrieval_enhancement_resolved_from,
			"policy_version": self.policy_version,
		}


@dataclass(frozen=True, slots=True)
class ResolvedDocumentPolicy:
	document_profile: str
	scan_handling: str
	parse_preference: str
	chunk_profile: str
	semantic_enabled: bool | None
	# OCR: auto → leave deploy defaults; disabled/force_ocr override parse path.
	ocr_enabled: bool | None
	# local_only / scan disabled → no MinerU/external enhanced parser.
	enhanced_parser_allowed: bool
	# quality → prefer enhanced path when deploy allows (not provider selection).
	prefer_enhanced: bool

	def as_dict(self) -> dict[str, Any]:
		return asdict(self)


@dataclass(frozen=True, slots=True)
class ResolvedParsePlan:
	"""User parse intents × deploy flags → effective knobs + fail-closed reason."""

	parse_preference: str
	scan_handling: str
	enhanced_parser_allowed: bool
	prefer_enhanced: bool
	ocr_enabled: bool | None
	# True only when this library may actually send bytes off-box (302).
	external_processing_allowed: bool
	degrade_reason: str | None
	degrade_message: str | None

	def as_dict(self) -> dict[str, Any]:
		return asdict(self)


def is_public_ask_payload(raw: dict[str, Any] | None) -> bool:
	if not raw:
		return False
	return any(key in raw for key in ASK_PUBLIC_PROFILE_KEYS)


def is_legacy_ask_payload(raw: dict[str, Any] | None) -> bool:
	if not raw:
		return False
	legacy_only = (
		"retrieve_top_k",
		"answer_min_score",
		"hybrid_enabled",
		"rerank_enabled",
		"citation_adjudicate_enabled",
		"citation_adjudicate_absolute_floor",
		"session_memory_max_turns",
	)
	return any(key in raw for key in legacy_only) and not is_public_ask_payload(raw)


def normalize_public_ask(raw: dict[str, Any] | None) -> dict[str, Any]:
	"""Validate/fill public ask contract (no legacy knobs)."""
	src = raw if isinstance(raw, dict) else {}
	answer = str(src.get("answer_profile") or PUBLIC_ASK_DEFAULTS["answer_profile"]).strip().lower()
	if answer not in ANSWER_PROFILES:
		answer = PUBLIC_ASK_DEFAULTS["answer_profile"]
	enhancement = str(
		src.get("retrieval_enhancement") or PUBLIC_ASK_DEFAULTS["retrieval_enhancement"]
	).strip().lower()
	if enhancement not in RETRIEVAL_ENHANCEMENTS:
		enhancement = PUBLIC_ASK_DEFAULTS["retrieval_enhancement"]
	evidence = str(
		src.get("evidence_requirement") or PUBLIC_ASK_DEFAULTS["evidence_requirement"]
	).strip().lower()
	if evidence not in EVIDENCE_REQUIREMENTS:
		evidence = PUBLIC_ASK_DEFAULTS["evidence_requirement"]
	memory = src.get("session_memory_enabled")
	if not isinstance(memory, bool):
		memory = PUBLIC_ASK_DEFAULTS["session_memory_enabled"]
	return {
		"answer_profile": answer,
		"retrieval_enhancement": enhancement,
		"session_memory_enabled": memory,
		"evidence_requirement": evidence,
	}


def migrate_legacy_ask_to_public(raw: dict[str, Any] | None) -> dict[str, Any]:
	"""Map stored numeric/boolean knobs → closest public profiles."""
	if not raw or not isinstance(raw, dict):
		return dict(PUBLIC_ASK_DEFAULTS)
	if is_public_ask_payload(raw):
		return normalize_public_ask(raw)

	top_k = raw.get("retrieve_top_k", ASK_DEFAULTS.retrieve_top_k)
	min_score = raw.get("answer_min_score", ASK_DEFAULTS.answer_min_score)
	try:
		top_k_i = int(top_k)
	except (TypeError, ValueError):
		top_k_i = ASK_DEFAULTS.retrieve_top_k
	try:
		min_score_f = float(min_score)
	except (TypeError, ValueError):
		min_score_f = ASK_DEFAULTS.answer_min_score

	# Closest answer_profile by min_score then top_k.
	if min_score_f >= 0.5 or top_k_i <= 4:
		answer_profile = "precise"
	elif min_score_f <= 0.3 or top_k_i >= 9:
		answer_profile = "exploratory"
	else:
		answer_profile = "balanced"

	hybrid = raw.get("hybrid_enabled")
	rerank = raw.get("rerank_enabled")
	if hybrid is True and rerank is True:
		enhancement = "on"
	elif hybrid is False and rerank is False:
		enhancement = "off"
	elif hybrid is None and rerank is None:
		enhancement = "auto"
	elif hybrid or rerank:
		enhancement = "on"
	else:
		enhancement = "off"

	floor = raw.get(
		"citation_adjudicate_absolute_floor",
		ASK_DEFAULTS.citation_adjudicate_absolute_floor,
	)
	try:
		floor_f = float(floor)
	except (TypeError, ValueError):
		floor_f = ASK_DEFAULTS.citation_adjudicate_absolute_floor
	adjudicate = raw.get("citation_adjudicate_enabled")
	if adjudicate is False or floor_f <= 0.28:
		evidence = "relaxed"
	elif floor_f >= 0.4 or min_score_f >= 0.5:
		evidence = "strict"
	else:
		evidence = "standard"

	memory = raw.get("session_memory_enabled")
	if not isinstance(memory, bool):
		memory = PUBLIC_ASK_DEFAULTS["session_memory_enabled"]

	return {
		"answer_profile": answer_profile,
		"retrieval_enhancement": enhancement,
		"session_memory_enabled": memory,
		"evidence_requirement": evidence,
	}


def resolve_retrieval_enhancement(
	mode: str,
	*,
	question: str | None = None,
) -> tuple[bool, bool, str]:
	"""Return (hybrid, rerank, resolved_mode).

	auto: simple heuristic on question when provided; else product defaults
	(hybrid=false, rerank=false).
	"""
	normalized = (mode or "auto").strip().lower()
	if normalized == "off":
		return False, False, "off"
	if normalized == "on":
		return True, True, "on"
	# auto
	if question and _looks_like_precise_lookup(question):
		return True, True, "auto"
	return (
		ASK_DEFAULTS.hybrid_enabled,
		ASK_DEFAULTS.rerank_enabled,
		"auto",
	)


def _looks_like_precise_lookup(question: str) -> bool:
	text = (question or "").strip()
	if not text:
		return False
	digit_runs = sum(1 for ch in text if ch.isdigit())
	if digit_runs >= 3:
		return True
	# Common identifiers / codes
	import re

	if re.search(r"[A-Za-z]{1,8}[-_/]?\d{2,}", text):
		return True
	if re.search(r"\b(编号|条款|第\s*\d+|版本|SKU|ID)\b", text, re.I):
		return True
	return False


def resolve_ask_policy(
	raw: dict[str, Any] | None,
	*,
	question: str | None = None,
	policy_version: int | None = None,
) -> ResolvedAskPolicy:
	"""Resolve public (or legacy) ask payload to internal knobs."""
	if is_legacy_ask_payload(raw) and not is_public_ask_payload(raw):
		# Pass-through legacy knobs with defaults fill; still emit a public view.
		public = migrate_legacy_ask_to_public(raw)
		cleaned = {k: raw[k] for k in ASK_LEGACY_KEYS if k in raw and raw[k] is not None}  # type: ignore[index]
		merged = {**{k: getattr(ASK_DEFAULTS, k) for k in ASK_OVERRIDE_KEYS}, **cleaned}
		hybrid = bool(merged["hybrid_enabled"])
		rerank = bool(merged["rerank_enabled"])
		return ResolvedAskPolicy(
			public=public,
			retrieve_top_k=int(merged["retrieve_top_k"]),
			answer_min_score=float(merged["answer_min_score"]),
			hybrid_enabled=hybrid,
			rerank_enabled=rerank,
			citation_adjudicate_enabled=bool(merged["citation_adjudicate_enabled"]),
			citation_adjudicate_absolute_floor=float(
				merged["citation_adjudicate_absolute_floor"]
			),
			session_memory_enabled=bool(merged["session_memory_enabled"]),
			session_memory_max_turns=int(merged["session_memory_max_turns"]),
			retrieval_enhancement_resolved_from=public["retrieval_enhancement"],
			policy_version=policy_version,
		)

	public = normalize_public_ask(raw)
	base = dict(_ANSWER_PROFILE_BASE[public["answer_profile"]])
	evidence = _EVIDENCE_FLOORS[public["evidence_requirement"]]

	min_score = float(base["answer_min_score"]) + float(evidence.get("min_score_delta") or 0)
	floor = float(base["citation_adjudicate_absolute_floor"]) + float(
		evidence.get("absolute_floor_delta") or 0
	)
	# Stricter wins for refusal/citation.
	min_score = max(min_score, float(evidence["min_score_floor"]))
	floor = max(floor, float(evidence["absolute_floor"]))
	min_score = max(0.0, min(1.0, min_score))
	floor = max(0.0, min(1.0, floor))
	adjudicate = bool(base["citation_adjudicate_enabled"])
	if evidence.get("requires_adjudicate"):
		adjudicate = True

	hybrid, rerank, resolved_enhancement = resolve_retrieval_enhancement(
		public["retrieval_enhancement"],
		question=question,
	)

	return ResolvedAskPolicy(
		public=public,
		retrieve_top_k=int(base["retrieve_top_k"]),
		answer_min_score=min_score,
		hybrid_enabled=hybrid,
		rerank_enabled=rerank,
		citation_adjudicate_enabled=adjudicate,
		citation_adjudicate_absolute_floor=floor,
		session_memory_enabled=bool(public["session_memory_enabled"]),
		session_memory_max_turns=ASK_DEFAULTS.session_memory_max_turns,
		retrieval_enhancement_resolved_from=resolved_enhancement,
		policy_version=policy_version,
	)


def resolve_document_policy(
	*,
	document_profile: str | None = None,
	scan_handling: str | None = None,
	parse_preference: str | None = None,
) -> ResolvedDocumentPolicy:
	profile = (document_profile or "auto").strip().lower()
	if profile not in DOCUMENT_PROFILES:
		profile = "auto"
	scan = (scan_handling or "auto").strip().lower()
	if scan not in SCAN_HANDLINGS:
		scan = "auto"
	preference = (parse_preference or "auto").strip().lower()
	if preference not in PARSE_PREFERENCES:
		preference = "auto"
	mapped = _DOCUMENT_PROFILE_MAP[profile]
	ocr: bool | None
	if scan == "disabled":
		ocr = False
	elif scan == "force_ocr":
		ocr = True
	else:
		ocr = None  # deploy default / auto
	# Intent: local_only or scan disabled → never call MinerU / external.
	enhanced = scan != "disabled" and preference != "local_only"
	return ResolvedDocumentPolicy(
		document_profile=profile,
		scan_handling=scan,
		parse_preference=preference,
		chunk_profile=str(mapped["chunk_profile"]),
		semantic_enabled=mapped["semantic_enabled"],
		ocr_enabled=ocr,
		enhanced_parser_allowed=enhanced,
		prefer_enhanced=preference == "quality" and enhanced,
	)


def resolve_parse_plan(
	*,
	parse_preference: str | None = None,
	scan_handling: str | None = None,
	document_profile: str | None = None,
	mineru_enabled: bool = False,
	mineru_provider: str = "self_hosted",
	external_parser_allowed: bool = False,
) -> ResolvedParsePlan:
	"""Map library intents + deploy flags to an effective parse plan.

	Deploy-only (never from UI): MINERU_PROVIDER, API keys, EXTERNAL_PARSER_ALLOWED,
	base URLs, cost rates/budgets, timeouts, capacity.
	"""
	policy = resolve_document_policy(
		document_profile=document_profile,
		scan_handling=scan_handling,
		parse_preference=parse_preference,
	)
	provider = (mineru_provider or "self_hosted").strip().lower()
	if provider not in {"self_hosted", "302ai"}:
		provider = "self_hosted"

	enhanced = policy.enhanced_parser_allowed
	prefer = policy.prefer_enhanced
	degrade_reason: str | None = None
	degrade_message: str | None = None

	if policy.parse_preference == "quality":
		if policy.scan_handling == "disabled":
			# quality + disabled scan: intent conflict → local text-only wins.
			enhanced = False
			prefer = False
			degrade_reason = "scan_handling_disabled"
			degrade_message = "已禁用扫描件识别（仅文本），无法使用高质量解析"
		elif not mineru_enabled:
			enhanced = False
			prefer = False
			degrade_reason = "deploy_mineru_disabled"
			degrade_message = "部署未启用增强解析，已回退基础解析（PyMuPDF）"
		elif provider == "302ai" and not external_parser_allowed:
			# Fail-closed: quality wanted but deploy forbids out-of-domain.
			enhanced = False
			prefer = False
			degrade_reason = "external_parser_forbidden"
			degrade_message = "部署禁止文档出域，已回退本地解析"
	elif policy.parse_preference == "local_only":
		enhanced = False
		prefer = False
	elif not enhanced:
		# scan_handling=disabled without quality preference
		pass

	# Auto path still respects deploy MinerU availability at runtime; do not
	# pre-disable enhanced here so probe/queue_class stays consistent.

	external_ok = bool(
		enhanced
		and mineru_enabled
		and provider == "302ai"
		and external_parser_allowed
	)

	return ResolvedParsePlan(
		parse_preference=policy.parse_preference,
		scan_handling=policy.scan_handling,
		enhanced_parser_allowed=enhanced,
		prefer_enhanced=prefer,
		ocr_enabled=policy.ocr_enabled,
		external_processing_allowed=external_ok,
		degrade_reason=degrade_reason,
		degrade_message=degrade_message,
	)
