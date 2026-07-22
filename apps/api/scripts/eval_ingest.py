#!/usr/bin/env python3
"""Offline ingest eval entry — delegates to pytest eval skeleton.

  uv run python scripts/eval_ingest.py
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path


def main() -> int:
	root = Path(__file__).resolve().parents[1]
	cmd = [sys.executable, "-m", "pytest", "tests/eval", "-q"]
	print(" ".join(cmd))
	return subprocess.call(cmd, cwd=root)


if __name__ == "__main__":
	raise SystemExit(main())
