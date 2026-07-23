#!/usr/bin/env python3
"""Phase 1 黄金集 runner 入口。

  cd apps/api && uv run python scripts/run_eval_cases.py
  cd apps/api && uv run python -m app.eval.runner
"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
	sys.path.insert(0, str(ROOT))

from app.eval.runner import main

if __name__ == "__main__":
	raise SystemExit(main())
