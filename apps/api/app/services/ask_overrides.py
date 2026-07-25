"""Per-request ask setting overrides (workspace knobs → ask_overrides).

Layering: workspace / request overrides  >  code ASK_DEFAULTS (never env).
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

from app.services.ask_defaults import (
	ASK_DEFAULTS,
	ASK_OVERRIDE_KEYS,
	ask_defaults_dict,
)

# Re-export for callers / tests.
__all__ = [
	"ASK_DEFAULTS",
	"ASK_OVERRIDE_KEYS",
	"ask_settings_namespace",
	"effective_ask_settings",
	"has_ask_overrides",
]


def _clean_overrides(overrides: dict[str, Any] | None) -> dict[str, Any]:
	if not overrides:
		return {}
	cleaned: dict[str, Any] = {}
	for key in ASK_OVERRIDE_KEYS:
		if key not in overrides:
			continue
		value = overrides[key]
		if value is None:
			continue
		cleaned[key] = value
	return cleaned


def has_ask_overrides(overrides: dict[str, Any] | None) -> bool:
	return bool(_clean_overrides(overrides))


class _EffectiveAskSettings:
	"""Settings view: ask knobs from defaults⊕overrides; other attrs from base Settings."""

	__slots__ = ("_base", "_ask")

	def __init__(self, base: Any, ask: dict[str, Any]) -> None:
		object.__setattr__(self, "_base", base)
		object.__setattr__(self, "_ask", ask)

	def __getattr__(self, name: str) -> Any:
		ask = object.__getattribute__(self, "_ask")
		if name in ask:
			return ask[name]
		return getattr(object.__getattribute__(self, "_base"), name)

	def __repr__(self) -> str:
		return f"EffectiveAskSettings(ask={self._ask!r})"


def effective_ask_settings(
	settings: Any,
	overrides: dict[str, Any] | None = None,
) -> _EffectiveAskSettings:
	"""Return a settings proxy: code defaults ⊕ ask_overrides for product knobs."""
	ask = {**ask_defaults_dict(), **_clean_overrides(overrides)}
	return _EffectiveAskSettings(settings, ask)


def ask_settings_namespace(
	settings: Any,
	overrides: dict[str, Any] | None = None,
) -> SimpleNamespace:
	effective = effective_ask_settings(settings, overrides)
	return SimpleNamespace(**{key: getattr(effective, key) for key in ASK_OVERRIDE_KEYS})
