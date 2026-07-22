from __future__ import annotations

from dataclasses import dataclass, field

from app.services.qdrant_store import probe_qdrant
from app.settings import Settings


@dataclass(frozen=True)
class RuntimeCapability:
	requested_mode: str
	effective_mode: str
	graph: str
	degraded: bool
	has_llm_key: bool
	qdrant_ok: bool
	reasons: list[str] = field(default_factory=list)

	@property
	def live_ready(self) -> bool:
		return self.has_llm_key and self.qdrant_ok


def resolve_runtime(settings: Settings, *, qdrant_ok: bool | None = None) -> RuntimeCapability:
	requested = "live" if settings.wants_live else "stub"
	has_key = settings.has_llm_key
	qdrant = probe_qdrant(settings) if qdrant_ok is None else qdrant_ok
	reasons: list[str] = []

	if requested == "live":
		if not has_key:
			reasons.append("missing_llm_api_key")
		if not qdrant:
			reasons.append("qdrant_unreachable")
		if has_key and qdrant:
			return RuntimeCapability(
				requested_mode=requested,
				effective_mode="live",
				graph="ask_v1",
				degraded=False,
				has_llm_key=has_key,
				qdrant_ok=qdrant,
				reasons=[],
			)
		return RuntimeCapability(
			requested_mode=requested,
			effective_mode="stub",
			graph="ask_v1",
			degraded=True,
			has_llm_key=has_key,
			qdrant_ok=qdrant,
			reasons=reasons or ["live_unavailable"],
		)

	return RuntimeCapability(
		requested_mode=requested,
		effective_mode="stub",
		graph="ask_v1",
		degraded=False,
		has_llm_key=has_key,
		qdrant_ok=qdrant,
		reasons=[],
	)
