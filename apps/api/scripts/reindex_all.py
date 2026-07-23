#!/usr/bin/env python3
"""全量 reindex：对所有库文档调用 POST /v1/documents/{id}/reindex。

用法（API 已启动）：

  python scripts/reindex_all.py
  python scripts/reindex_all.py --base-url http://127.0.0.1:8000

默认 INGEST_ASYNC=true 时接口返回 202/processing；本脚本会轮询
GET /v1/documents/{id} 直至 ready / failed / 超时，再计入成功或失败。
同步模式（INGEST_ASYNC=false）则按单次响应直接判定。

幂等路径：process_document_ingest → delete_by_doc_id → upsert（含 chunk/section/table）。
扫描件等无法抽取正文的文档会失败，属预期。
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.request


def _get(url: str):
	with urllib.request.urlopen(url, timeout=60) as resp:
		return json.load(resp)


def _post(url: str):
	req = urllib.request.Request(url, method="POST", data=b"")
	with urllib.request.urlopen(req, timeout=180) as resp:
		return resp.status, json.load(resp)


def _wait_document_status(
	base: str,
	doc_id: str,
	*,
	timeout_s: float,
	poll_s: float,
) -> dict:
	"""轮询文档状态直至 ready / failed / 超时。"""
	deadline = time.monotonic() + max(1.0, timeout_s)
	last: dict | None = None
	while time.monotonic() < deadline:
		last = _get(f"{base}/v1/documents/{doc_id}")
		status = str(last.get("status") or "")
		if status in {"ready", "failed"}:
			return last
		time.sleep(max(0.2, poll_s))
	if last is None:
		return {"id": doc_id, "status": "timeout", "error": "poll failed to start"}
	out = dict(last)
	out["status"] = "timeout"
	out.setdefault("error", f"still {last.get('status')} after {timeout_s}s")
	return out


def main() -> int:
	parser = argparse.ArgumentParser(description="Reindex all MeriKnow documents")
	parser.add_argument("--base-url", default="http://127.0.0.1:8000")
	parser.add_argument(
		"--allow-partial",
		action="store_true",
		help="若有失败但仍有成功，仍以 0 退出（默认：任一失败非 0）",
	)
	parser.add_argument(
		"--timeout",
		type=float,
		default=600.0,
		help="异步 reindex 轮询超时秒数（默认 600）",
	)
	parser.add_argument(
		"--poll-interval",
		type=float,
		default=2.0,
		help="异步 reindex 轮询间隔秒数（默认 2）",
	)
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
				body_status = str(body.get("status") or "")
				# 202 / processing：异步入队，必须轮询终态，不能直接计成功
				if code == 202 or body_status == "processing":
					print(f"  WAIT {code} {doc_id} {name} (async polling…)")
					final = _wait_document_status(
						base,
						doc_id,
						timeout_s=args.timeout,
						poll_s=args.poll_interval,
					)
					final_status = str(final.get("status") or "")
					if final_status == "ready":
						print(
							f"  OK ready {doc_id} {name} "
							f"chunks={final.get('chunk_count')}"
						)
						ok += 1
					elif final_status == "failed":
						err = final.get("error") or "reindex failed"
						print(f"  FAIL async {doc_id} {name}: {err}")
						fail += 1
					else:
						err = final.get("error") or f"status={final_status}"
						print(f"  FAIL timeout {doc_id} {name}: {err}")
						fail += 1
				else:
					print(
						f"  OK {code} {doc_id} {name} -> {body_status} "
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
	if fail == 0:
		return 0
	if args.allow_partial and ok > 0:
		return 0
	return 1


if __name__ == "__main__":
	raise SystemExit(main())
