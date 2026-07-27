"""Eval runtime isolation — settings cache, metadata singleton, ablation knobs."""

from __future__ import annotations

import os
from contextlib import contextmanager
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any

# Eval ask knobs: code defaults ⊕ these fixed overrides (never env).
EVAL_ASK_OVERRIDES = {
	"session_memory_enabled": False,
	"hybrid_enabled": False,
	"rerank_enabled": False,
}


def resolve_ablation(case: Any) -> tuple[dict[str, Any], dict[str, str], str | None]:
	"""Return (ask_overrides, env, skip_reason) for a case's policy_variant."""
	from app.eval.ablation import variant_by_id

	if not case.policy_variant:
		return dict(EVAL_ASK_OVERRIDES), {"MAX_RETRIEVE_RETRIES": "0"}, None
	try:
		variant = variant_by_id(case.policy_variant)
	except KeyError:
		return dict(EVAL_ASK_OVERRIDES), {"MAX_RETRIEVE_RETRIES": "0"}, (
			f"unknown policy_variant={case.policy_variant}"
		)
	if variant.not_evaluable:
		return (
			dict(variant.ask_overrides),
			dict(variant.env),
			variant.note or f"{variant.id} not evaluable yet",
		)
	if variant.requires_graph_hook:
		return (
			dict(variant.ask_overrides),
			dict(variant.env),
			variant.note or f"{variant.id} requires graph hook",
		)
	return dict(variant.ask_overrides), dict(variant.env), None


@contextmanager
def isolated_ask_settings(env_overrides: dict[str, str] | None = None):
	"""隔离 eval 对环境、settings cache 和 metadata singleton 的修改。"""
	from app.graph.ask_graph import AskGraphService, stub_load_table_groups
	from app.security.access_scope import AccessScope
	from app.services.metadata import reset_metadata_store
	from app.settings import get_settings

	keys = (
		"ASK_MODE",
		"METADATA_BACKEND",
		"METADATA_PATH",
		"MAX_RETRIEVE_RETRIES",
		"INTERNAL_AUTH_ENABLED",
	)
	previous = {key: os.environ.get(key) for key in keys}
	extra_env = dict(env_overrides or {})
	with TemporaryDirectory(prefix="meriknow-eval-") as tmp_dir:
		os.environ.update(
			{
				"ASK_MODE": "stub",
				"METADATA_BACKEND": "json",
				"METADATA_PATH": str(Path(tmp_dir) / "metadata.json"),
				"MAX_RETRIEVE_RETRIES": extra_env.get("MAX_RETRIEVE_RETRIES", "0"),
				# Avoid host .env INTERNAL_AUTH_ENABLED=true requiring request scope.
				"INTERNAL_AUTH_ENABLED": "false",
			}
		)
		for key, value in extra_env.items():
			if key not in {"MAX_RETRIEVE_RETRIES"}:
				os.environ[key] = value
		get_settings.cache_clear()
		reset_metadata_store()
		try:
			settings = get_settings()
			yield AskGraphService(
				settings=settings,
				access_scope=AccessScope.development(settings),
				# Align with stub_retrieve / test_ask_route table shape.
				load_table_groups_fn=stub_load_table_groups,
			)
		finally:
			reset_metadata_store()
			for key, value in previous.items():
				if value is None:
					os.environ.pop(key, None)
				else:
					os.environ[key] = value
			get_settings.cache_clear()


# Transition aliases.
_EVAL_ASK_OVERRIDES = EVAL_ASK_OVERRIDES
_resolve_ablation = resolve_ablation
_isolated_ask_settings = isolated_ask_settings
