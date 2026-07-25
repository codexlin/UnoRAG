"""reindex_all script is retired (FastAPI reindex is 410)."""

from __future__ import annotations

import importlib.util
from pathlib import Path

_SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "reindex_all.py"


def _load_reindex_module():
	spec = importlib.util.spec_from_file_location("reindex_all_script", _SCRIPT)
	assert spec and spec.loader
	mod = importlib.util.module_from_spec(spec)
	spec.loader.exec_module(mod)
	return mod


def test_reindex_all_script_is_retired() -> None:
	mod = _load_reindex_module()
	assert mod.main() == 2
