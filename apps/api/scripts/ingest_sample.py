#!/usr/bin/env python3
"""Ingest a sample HR snippet into Qdrant for local live verification.

Requires ASK_MODE=live, LLM API key, and a running Qdrant.

Usage (from apps/api):

  uv run python scripts/ingest_sample.py
"""

from __future__ import annotations

import sys
from pathlib import Path

# Allow `uv run python scripts/ingest_sample.py` from apps/api
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.services.metadata import get_metadata_store
from app.services.retrieval import IngestService
from app.services.runtime import resolve_runtime
from app.settings import get_settings

SAMPLE = """
员工手册 · 休假篇（节选）

病假须于返岗后三个工作日内补交证明材料，并由直属主管确认。
未能按期提交病假证明的，人力资源部有权按事假或旷工规则核算。

试用期考核通过标准：岗位关键指标达标，且无严重违纪记录。
""".strip()


def main() -> int:
	settings = get_settings()
	capability = resolve_runtime(settings)
	if not capability.live_ready:
		print(
			"live unavailable:",
			{
				"requested": capability.requested_mode,
				"effective": capability.effective_mode,
				"degraded": capability.degraded,
				"reasons": capability.reasons,
			},
		)
		return 1

	meta = get_metadata_store(settings)
	library_id = "lib-sample"
	if meta.get_library(library_id) is None:
		meta.create_library(name="样例知识库", library_id=library_id)
		print("created library:", library_id)

	result = IngestService(settings).ingest_text(
		library_id=library_id,
		title="员工手册-休假篇.pdf",
		text=SAMPLE,
		doc_id="sample-hr-leave",
	)
	print("ingested:", result)
	print(
		'try: POST /v1/ask '
		f'{{"question":"病假需要在几天内补交证明？","library_id":"{library_id}"}}'
	)
	return 0


if __name__ == "__main__":
	raise SystemExit(main())
