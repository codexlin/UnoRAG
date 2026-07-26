"""Per-request ask setting overrides (workspace knobs → ask_overrides).

Layering:
  resolve(public profiles | legacy knobs)  >  code ASK_DEFAULTS (never env).

Public business-intent keys are preferred; legacy numeric knobs remain accepted
for one release and direct API tests.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

from app.services.ask_defaults import (
	ASK_DEFAULTS,
	ASK_OVERRIDE_KEYS,
	ask_defaults_dict,
)
from app.services.policy_profiles import (
	is_public_ask_payload,
	resolve_ask_policy,
)

# Re-export for callers / tests.
__all__ = [
	"ASK_DEFAULTS",
	"ASK_OVERRIDE_KEYS",
	"ask_settings_namespace",
	"effective_ask_settings",
	"extract_ask_policy_snapshot",
	"has_ask_overrides",
	"resolve_overrides_to_knobs",
]


def extract_ask_policy_snapshot(
	overrides: dict[str, Any] | None,
) -> dict[str, Any] | None:
	"""Pull `_ask_policy` meta injected by control plane (not an ask knob)."""
	if not overrides or not isinstance(overrides, dict):
		return None
	raw = overrides.get("_ask_policy")
	return dict(raw) if isinstance(raw, dict) else None


def resolve_overrides_to_knobs(
	overrides: dict[str, Any] | None,
	*,
	question: str | None = None,
) -> dict[str, Any]:
	"""Normalize ask_overrides (public or legacy) to ASK_OVERRIDE_KEYS dict."""
	if not overrides:
		return {}
	# Strip control-plane meta before resolution.
	clean_input = {
		key: value
		for key, value in overrides.items()
		if key != "_ask_policy" and value is not None
	}
	if not clean_input:
		return {}

	policy_version = None
	snapshot = extract_ask_policy_snapshot(overrides)
	if snapshot and isinstance(snapshot.get("policy_version"), int):
		policy_version = snapshot["policy_version"]

	if is_public_ask_payload(clean_input):
		resolved = resolve_ask_policy(
			clean_input,
			question=question,
			policy_version=policy_version,
		)
		return resolved.as_override_knobs()

	# Legacy path: only known knob keys (tests / one-release compat).
	cleaned: dict[str, Any] = {}
	for key in ASK_OVERRIDE_KEYS:
		if key not in clean_input:
			continue
		cleaned[key] = clean_input[key]
	if not cleaned:
		return {}
	resolved = resolve_ask_policy(
		cleaned,
		question=question,
		policy_version=policy_version,
	)
	return resolved.as_override_knobs()


def _clean_overrides(overrides: dict[str, Any] | None) -> dict[str, Any]:
	return resolve_overrides_to_knobs(overrides)


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
	*,
	question: str | None = None,
) -> _EffectiveAskSettings:
	"""Return a settings proxy: code defaults ⊕ resolved ask_overrides."""
	ask = {
		**ask_defaults_dict(),
		**resolve_overrides_to_knobs(overrides, question=question),
	}
	return _EffectiveAskSettings(settings, ask)


def ask_settings_namespace(
	settings: Any,
	overrides: dict[str, Any] | None = None,
	*,
	question: str | None = None,
) -> SimpleNamespace:
	effective = effective_ask_settings(settings, overrides, question=question)
	return SimpleNamespace(**{key: getattr(effective, key) for key in ASK_OVERRIDE_KEYS})
