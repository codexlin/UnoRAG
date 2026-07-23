#!/usr/bin/env python3
"""全量 reindex：对所有库文档调用 POST /v1/documents/{id}/reindex。

用法（API 已启动，且 INGEST_ASYNC=false 更易同步完成）：

  python scripts/reindex_all.py
  python scripts/reindex_all.py --base-url http://127.0.0.1:8000

幂等路径：process_document_ingest → delete_by_doc_id → upsert（含 chunk/section/table）。
扫描件等无法抽取正文的文档会失败，属预期。
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.request


def _get(url: str):
	with urllib.request.urlopen(url, timeout=60) as resp:
		return json.load(resp)


def _post(url: str):
	req = urllib.request.Request(url, method="POST", data=b"")
	with urllib.request.urlopen(req, timeout=180) as resp:
		return resp.status, json.load(resp)


def main() -> int:
	parser = argparse.ArgumentParser(description="Reindex all MeriKnow documents")
	parser.add_argument("--base-url", default="http://127.0.0.1:8000")
	args = parser.parse_args()
	base = args.base_url.rstrip("/")

	health = _get(f"{base}/health")
	print("health:", json.dumps(health, ensure_ascii=False))
	if not health.get("live_ready") and not health.get("ask_ready"):
		print("WARN: API not live_ready; reindex may 503", file=sys.stderr)

	libs = _get(f"{base}/v1/libraries")
	ok = fail = skip = 0
	for lib in libs:
		lib_id = lib["id"]
		docs = _get(f"{base}/v1/libraries/{lib_id}/documents")
		print(f"=== {lib_id} docs={len(docs)} ===")
		for doc in docs:
			doc_id = doc["id"]
			name = doc.get("name") or doc.get("filename")
			status = doc.get("status")
			if status == "processing":
				print(f"  SKIP processing {doc_id} {name}")
				skip += 1
				continue
			try:
				code, body = _post(f"{base}/v1/documents/{doc_id}/reindex")
				print(
					f"  OK {code} {doc_id} {name} -> {body.get('status')} "
					f"chunks={body.get('chunk_count')}"
				)
				ok += 1
			except urllib.error.HTTPError as exc:
				err = exc.read().decode("utf-8", "replace")
				print(f"  FAIL {exc.code} {doc_id} {name}: {err[:240]}")
				fail += 1
			except Exception as exc:  # noqa: BLE001
				print(f"  ERR {doc_id} {name}: {exc}")
				fail += 1

	print(f"DONE ok={ok} fail={fail} skip={skip}")
	return 0 if fail == 0 or ok > 0 else 1


if __name__ == "__main__":
	raise SystemExit(main())
