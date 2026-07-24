#!/usr/bin/env python3
"""Full live E2E: upload testdata/ab fixtures via control plane, then score golds.jsonl."""

from __future__ import annotations

import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from http.cookiejar import CookieJar
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
AB = ROOT / "testdata" / "ab"
GOLDS = AB / "golds.jsonl"
OUT_DIR = AB / "_e2e_out"
BASE = os.environ.get("MERIKNOW_BASE_URL", "http://127.0.0.1:3000").rstrip("/")
JOB_TIMEOUT_S = int(os.environ.get("MERIKNOW_AB_JOB_TIMEOUT_SEC", "900"))
ASK_TIMEOUT_S = int(os.environ.get("MERIKNOW_AB_ASK_TIMEOUT_SEC", "120"))


def load_dotenv(path: Path) -> dict[str, str]:
	out: dict[str, str] = {}
	if not path.is_file():
		return out
	for line in path.read_text(encoding="utf-8").splitlines():
		line = line.strip()
		if not line or line.startswith("#") or "=" not in line:
			continue
		k, _, v = line.partition("=")
		out[k.strip()] = v.strip().strip('"').strip("'")
	return out


def key_facts_from(case: dict) -> list[str]:
	facts = case.get("key_facts")
	if isinstance(facts, list) and facts:
		return [str(x) for x in facts]
	answer = str(case.get("answer") or "")
	found: list[str] = []
	found.extend(re.findall(r"[¥￥]?\d{1,3}(?:,\d{3})+(?:\.\d+)?%?", answer))
	found.extend(re.findall(r"\d+(?:\.\d+)?%", answer))
	found.extend(re.findall(r"\d{4}年\d{1,2}月\d{1,2}日", answer))
	found.extend(re.findall(r"[「『\"“]([^」』\"”]{2,40})[」』\"”]", answer))
	# de-dupe preserve order
	seen: set[str] = set()
	uniq: list[str] = []
	for f in found:
		if f not in seen:
			seen.add(f)
			uniq.append(f)
	return uniq[:8] if uniq else ([answer[:40]] if answer else [])


class Client:
	def __init__(self, base: str) -> None:
		self.base = base
		self.jar = CookieJar()
		self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.jar))

	def request(
		self,
		method: str,
		path: str,
		*,
		data: bytes | None = None,
		headers: dict[str, str] | None = None,
		timeout: float = 60,
	) -> tuple[int, bytes]:
		req = urllib.request.Request(
			self.base + path,
			data=data,
			method=method,
			headers=headers or {},
		)
		try:
			with self.opener.open(req, timeout=timeout) as resp:
				return resp.status, resp.read()
		except urllib.error.HTTPError as e:
			return e.code, e.read()

	def json(
		self,
		method: str,
		path: str,
		payload: dict | None = None,
		timeout: float = 60,
	) -> tuple[int, dict | list | str]:
		body = None
		headers: dict[str, str] = {}
		if payload is not None:
			body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
			headers["content-type"] = "application/json"
		code, raw = self.request(method, path, data=body, headers=headers, timeout=timeout)
		if not raw:
			return code, {}
		try:
			return code, json.loads(raw.decode("utf-8"))
		except json.JSONDecodeError:
			return code, raw.decode("utf-8", errors="replace")

	def upload(self, library_id: str, file_path: Path) -> tuple[int, dict]:
		boundary = f"----meriknow{int(time.time()*1000)}"
		filename = file_path.name
		content = file_path.read_bytes()
		# naive multipart
		parts = []
		parts.append(f"--{boundary}\r\n".encode())
		parts.append(
			f'Content-Disposition: form-data; name="file"; filename="{filename}"\r\n'.encode()
		)
		parts.append(b"Content-Type: application/octet-stream\r\n\r\n")
		parts.append(content)
		parts.append(f"\r\n--{boundary}--\r\n".encode())
		body = b"".join(parts)
		headers = {"content-type": f"multipart/form-data; boundary={boundary}"}
		code, raw = self.request(
			"POST",
			f"/api/libraries/{library_id}/documents",
			data=body,
			headers=headers,
			timeout=300,
		)
		try:
			return code, json.loads(raw.decode("utf-8"))
		except json.JSONDecodeError:
			return code, {"raw": raw.decode("utf-8", errors="replace")}


def main() -> int:
	env = {}
	env.update(load_dotenv(ROOT / "apps" / "web" / ".env.local"))
	env.update(load_dotenv(ROOT / "apps" / "web" / ".env"))
	email = os.environ.get("MERIKNOW_ADMIN_EMAIL") or env.get("MERIKNOW_ADMIN_EMAIL")
	password = os.environ.get("MERIKNOW_ADMIN_PASSWORD") or env.get("MERIKNOW_ADMIN_PASSWORD")
	if not email or not password:
		print("FAIL: missing MERIKNOW_ADMIN_EMAIL/PASSWORD", file=sys.stderr)
		return 2

	cases = []
	for line in GOLDS.read_text(encoding="utf-8").splitlines():
		if line.strip():
			cases.append(json.loads(line))
	files = sorted({c["file"] for c in cases})
	for f in files:
		if not (AB / f).is_file():
			print(f"FAIL: missing fixture {f}", file=sys.stderr)
			return 1

	OUT_DIR.mkdir(parents=True, exist_ok=True)
	stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
	client = Client(BASE)

	print(f"== health {BASE}")
	code, health = client.json("GET", "/api/rag/health")
	print("web_health", code, health if isinstance(health, dict) else str(health)[:120])
	if code != 200:
		return 1

	print("== login")
	code, login = client.json(
		"POST",
		"/api/auth/session",
		{"email": email, "password": password},
	)
	print("login", code)
	if code != 200:
		print(login)
		return 1

	token = f"ab-live-{int(time.time())}"
	print("== create library")
	code, lib = client.json("POST", "/api/libraries", {"name": f"AB Live {token}"})
	print("lib", code)
	if code not in (200, 201) or not isinstance(lib, dict):
		print(lib)
		return 1
	library_id = lib["id"]
	print("library_id", library_id)

	uploads: dict[str, dict] = {}
	print("== upload", len(files), "files")
	for fname in files:
		path = AB / fname
		code, payload = client.upload(library_id, path)
		print(f"  upload {fname} -> {code}")
		if code not in (200, 202) or not isinstance(payload, dict):
			print("   ", payload)
			uploads[fname] = {"ok": False, "http": code, "payload": payload}
			continue
		uploads[fname] = {
			"ok": True,
			"http": code,
			"document_id": payload.get("document_id") or payload.get("id"),
			"job_id": payload.get("job_id"),
			"status": payload.get("status"),
		}

	print("== wait jobs")
	job_results: dict[str, dict] = {}
	deadline = time.time() + JOB_TIMEOUT_S
	pending = {
		f: u["job_id"]
		for f, u in uploads.items()
		if u.get("ok") and u.get("job_id")
	}
	while pending and time.time() < deadline:
		done_files = []
		for fname, job_id in pending.items():
			code, job = client.json("GET", f"/api/jobs/{job_id}")
			if code != 200 or not isinstance(job, dict):
				continue
			st = job.get("status")
			stage = job.get("stage")
			print(f"  {fname}: status={st} stage={stage}")
			if st in ("completed", "failed", "dead", "cancelled"):
				pr = job.get("parser_report") or {}
				if isinstance(pr, str):
					try:
						pr = json.loads(pr)
					except json.JSONDecodeError:
						pr = {"raw": pr}
				job_results[fname] = {
					"job_id": job_id,
					"status": st,
					"stage": stage,
					"error": job.get("last_error") or job.get("error_code"),
					"parser_report": pr,
					"document_id": uploads[fname].get("document_id"),
				}
				done_files.append(fname)
		for f in done_files:
			pending.pop(f, None)
		if pending:
			time.sleep(5)

	for fname, job_id in pending.items():
		job_results[fname] = {
			"job_id": job_id,
			"status": "timeout",
			"stage": None,
			"error": "job wait timeout",
			"document_id": uploads[fname].get("document_id"),
		}

	# document statuses
	code, docs_payload = client.json("GET", f"/api/libraries/{library_id}/documents")
	docs = docs_payload if isinstance(docs_payload, list) else (
		docs_payload.get("documents") or docs_payload.get("items") or []
		if isinstance(docs_payload, dict)
		else []
	)
	doc_by_name = {}
	for d in docs:
		name = d.get("filename") or d.get("title") or d.get("name")
		if name:
			doc_by_name[name] = d

	print("== ask golds", len(cases))
	ask_rows = []
	passed = 0
	failed = 0
	for i, case in enumerate(cases, 1):
		fname = case["file"]
		job = job_results.get(fname) or {}
		facts = key_facts_from(case)
		row = {
			"i": i,
			"file": fname,
			"mode": case.get("mode"),
			"question": case["question"],
			"expect_record_type": case.get("expect_record_type"),
			"key_facts": facts,
			"ingest_status": job.get("status"),
		}
		if job.get("status") != "completed":
			row.update({"ok": False, "skip_reason": f"ingest not completed: {job.get('status')}"})
			failed += 1
			ask_rows.append(row)
			print(f"  [{i}/{len(cases)}] SKIP ingest={job.get('status')} {fname}")
			continue

		code, resp = client.json(
			"POST",
			"/api/rag/v1/ask",
			{"question": case["question"], "library_id": library_id},
			timeout=ASK_TIMEOUT_S,
		)
		answer = ""
		refused = None
		reason = None
		citations = []
		if isinstance(resp, dict):
			answer = str(resp.get("answer") or "")
			refused = resp.get("refused")
			reason = resp.get("refuse_reason")
			citations = resp.get("citations") or []
		missing = [f for f in facts if f and f not in answer]
		ok = code == 200 and not refused and not missing
		if ok:
			passed += 1
		else:
			failed += 1
		row.update(
			{
				"ok": ok,
				"http": code,
				"refused": refused,
				"refuse_reason": reason,
				"answer": answer[:500],
				"citations": len(citations),
				"missing_facts": missing,
			}
		)
		ask_rows.append(row)
		flag = "PASS" if ok else "FAIL"
		print(f"  [{i}/{len(cases)}] {flag} missing={missing[:3]} file={fname}")

	report = {
		"stamp": stamp,
		"base_url": BASE,
		"library_id": library_id,
		"files": files,
		"uploads": uploads,
		"jobs": job_results,
		"documents": [
			{
				"filename": d.get("filename") or d.get("title"),
				"status": d.get("status"),
				"id": d.get("id"),
			}
			for d in docs
		],
		"summary": {
			"cases": len(cases),
			"passed": passed,
			"failed": failed,
			"pass_rate": round(passed / len(cases), 4) if cases else 0,
			"ingest_completed": sum(1 for j in job_results.values() if j.get("status") == "completed"),
			"ingest_total": len(files),
		},
		"cases": ask_rows,
	}
	json_path = OUT_DIR / f"ab_live_{stamp}.json"
	md_path = OUT_DIR / f"ab_live_{stamp}.md"
	latest_json = OUT_DIR / "ab_live_latest.json"
	latest_md = OUT_DIR / "ab_live_latest.md"
	json_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
	latest_json.write_text(json_path.read_text(encoding="utf-8"), encoding="utf-8")

	lines = [
		f"# AB Live E2E {stamp}",
		"",
		f"- library_id: `{library_id}`",
		f"- ingest: {report['summary']['ingest_completed']}/{report['summary']['ingest_total']} completed",
		f"- ask: **{passed}/{len(cases)}** passed ({report['summary']['pass_rate']:.1%})",
		"",
		"## Ingest",
		"",
		"| file | job status | parser |",
		"|---|---|---|",
	]
	for fname in files:
		j = job_results.get(fname) or {}
		pr = j.get("parser_report") or {}
		backend = pr.get("parser_backend") or pr.get("backend") or pr.get("route") or ""
		lines.append(f"| `{fname}` | {j.get('status')} | {backend} |")
	lines.extend(["", "## Ask failures", ""])
	fails = [r for r in ask_rows if not r.get("ok")]
	if not fails:
		lines.append("_none_")
	else:
		for r in fails:
			lines.append(f"### {r['i']}. {r['file']}")
			lines.append(f"- Q: {r['question']}")
			if r.get("skip_reason"):
				lines.append(f"- skip: {r['skip_reason']}")
			else:
				lines.append(f"- refused: {r.get('refused')} reason={r.get('refuse_reason')}")
				lines.append(f"- missing: {r.get('missing_facts')}")
				lines.append(f"- answer: {(r.get('answer') or '')[:240]}")
			lines.append("")
	md_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
	latest_md.write_text(md_path.read_text(encoding="utf-8"), encoding="utf-8")

	print("== summary")
	print(json.dumps(report["summary"], ensure_ascii=False))
	print("report", json_path)
	print("report_md", md_path)
	return 0 if failed == 0 else 1


if __name__ == "__main__":
	raise SystemExit(main())
