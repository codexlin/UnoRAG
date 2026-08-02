#!/usr/bin/env python3
"""Full live E2E: upload testdata/ab fixtures via control plane, then score golds.jsonl."""

from __future__ import annotations

import atexit
import json
import os
import re
import statistics
import sys
import time
import unicodedata
import urllib.error
import urllib.request
from datetime import datetime, timezone
from decimal import Decimal
from http.cookiejar import CookieJar
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
AB = ROOT / "testdata" / "ab"
GOLDS = AB / "golds.jsonl"
OUT_DIR = AB / "_e2e_out"
BASE = os.environ.get("UNORAG_BASE_URL", "http://127.0.0.1:3000").rstrip("/")
JOB_TIMEOUT_S = int(os.environ.get("UNORAG_AB_JOB_TIMEOUT_SEC", "900"))
ASK_TIMEOUT_S = int(os.environ.get("UNORAG_AB_ASK_TIMEOUT_SEC", "120"))
KEEP_LIBRARY = os.environ.get("UNORAG_AB_KEEP_LIBRARY", "").strip().lower() in {
	"1",
	"true",
	"yes",
}

NEGATIVE_CASES = [
	"资料中规定的员工宠物医疗保险年度报销上限是多少？",
	"资料中火星分公司的办公地址和邮政编码是什么？",
	"资料中量子芯片 QZ-900 的保修年限是多少？",
	"资料中南极数据中心的柴油储备可以维持多少天？",
	"资料中 2029 年春节团建预算是多少？",
]


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


_CHINESE_DIGITS = {
	"零": 0,
	"〇": 0,
	"一": 1,
	"壹": 1,
	"二": 2,
	"两": 2,
	"贰": 2,
	"三": 3,
	"叁": 3,
	"四": 4,
	"肆": 4,
	"五": 5,
	"伍": 5,
	"六": 6,
	"陆": 6,
	"七": 7,
	"柒": 7,
	"八": 8,
	"捌": 8,
	"九": 9,
	"玖": 9,
}
_CHINESE_UNITS = {
	"十": 10,
	"拾": 10,
	"百": 100,
	"佰": 100,
	"千": 1_000,
	"仟": 1_000,
	"万": 10_000,
	"萬": 10_000,
	"亿": 100_000_000,
	"億": 100_000_000,
}
_CHINESE_NUMBER_RE = re.compile(
	r"[零〇一二两三四五六七八九十百千万亿"
	r"壹贰叁肆伍陆柒捌玖拾佰仟萬億]+"
)
_ARABIC_MAGNITUDE_RE = re.compile(r"(?<![\d.])(\d+(?:\.\d+)?)(万|萬|亿|億)")


def _parse_chinese_number(value: str) -> int:
	if not any(character in _CHINESE_UNITS for character in value):
		return int("".join(str(_CHINESE_DIGITS[character]) for character in value))

	total = 0
	section = 0
	number = 0
	for character in value:
		if character in _CHINESE_DIGITS:
			number = _CHINESE_DIGITS[character]
			continue
		unit = _CHINESE_UNITS[character]
		if unit < 10_000:
			section += (number or 1) * unit
		else:
			section += number
			total += (section or 1) * unit
			section = 0
		number = 0
	return total + section + number


def normalize_fact_text(value: str) -> str:
	"""Canonicalize representation without weakening fact-level matching."""
	text = unicodedata.normalize("NFKC", value).casefold()
	text = text.replace(r"\%", "%").replace("$", "")
	text = text.translate(
		str.maketrans(
			{"\u2010": "-", "\u2011": "-", "\u2012": "-", "\u2013": "-", "\u2014": "-", "\u2212": "-"}
		)
	)
	text = re.sub(r"(?<=\d),(?=\d{3}(?:\D|$))", "", text)
	text = _ARABIC_MAGNITUDE_RE.sub(
		lambda match: str(
			int(Decimal(match.group(1)) * _CHINESE_UNITS[match.group(2)])
		),
		text,
	)
	text = _CHINESE_NUMBER_RE.sub(
		lambda match: str(_parse_chinese_number(match.group(0))), text
	)
	return re.sub(r"\s+", "", text)


def fact_matches_answer(fact: str, answer: str) -> bool:
	normalized_fact = normalize_fact_text(fact)
	normalized_answer = normalize_fact_text(answer)
	pattern = re.escape(normalized_fact)
	if normalized_fact[0].isdigit():
		pattern = rf"(?<![\d.]){pattern}"
	if normalized_fact[-1].isdigit():
		pattern = rf"{pattern}(?![\d.])"
	return re.search(pattern, normalized_answer) is not None


def key_facts_from(case: dict) -> list[str]:
	facts = case.get("key_facts")
	if not isinstance(facts, list) or not facts:
		raise ValueError("gold case must define non-empty key_facts")
	if any(not isinstance(fact, str) for fact in facts):
		raise ValueError("gold case key_facts must contain strings")
	normalized = [fact.strip() for fact in facts]
	if any(not fact for fact in normalized):
		raise ValueError("gold case key_facts must contain non-empty strings")
	return normalized


def load_gold_cases(path: Path) -> list[dict]:
	cases: list[dict] = []
	for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
		if not line.strip():
			continue
		try:
			case = json.loads(line)
			if not isinstance(case, dict):
				raise ValueError("gold case must be an object")
			for field in ("file", "question", "answer"):
				if not isinstance(case.get(field), str) or not case[field].strip():
					raise ValueError(f"gold case must define non-empty {field}")
			facts = key_facts_from(case)
			missing_from_reference = [
				fact for fact in facts if not fact_matches_answer(fact, case["answer"])
			]
			if missing_from_reference:
				raise ValueError(
					f"key_facts not supported by reference answer: {missing_from_reference}"
				)
		except (json.JSONDecodeError, ValueError) as exc:
			raise ValueError(f"invalid gold at line {line_number}: {exc}") from exc
		cases.append(case)
	return cases


def citation_file(citation: dict) -> str:
	value = citation.get("filename") or citation.get("file") or ""
	return Path(str(value)).name


def percentile(values: list[float], ratio: float) -> float | None:
	if not values:
		return None
	ordered = sorted(values)
	index = min(len(ordered) - 1, max(0, int(len(ordered) * ratio + 0.999999) - 1))
	return round(ordered[index], 1)


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
		resolved_headers = dict(headers or {})
		if self.base.startswith(("http://127.0.0.1", "http://localhost")):
			# Production cookies are Secure. Browsers treat localhost as a secure
			# context, while urllib correctly refuses to attach them to plain HTTP.
			# Mirror browser localhost behavior without weakening remote HTTP.
			local_cookies = "; ".join(
				f"{cookie.name}={cookie.value}" for cookie in self.jar
			)
			if local_cookies:
				resolved_headers.setdefault("cookie", local_cookies)
		req = urllib.request.Request(
			self.base + path,
			data=data,
			method=method,
			headers=resolved_headers,
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
		boundary = f"----unorag{int(time.time()*1000)}"
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
	credentials_file = os.environ.get("UNORAG_AB_CREDENTIALS_FILE", "").strip()
	if credentials_file:
		env.update(load_dotenv(Path(credentials_file).expanduser()))
	email = os.environ.get("UNORAG_ADMIN_EMAIL") or env.get("UNORAG_ADMIN_EMAIL")
	password = os.environ.get("UNORAG_ADMIN_PASSWORD") or env.get("UNORAG_ADMIN_PASSWORD")
	password_file = os.environ.get("UNORAG_AB_PASSWORD_FILE", "").strip()
	if password_file:
		path = Path(password_file).expanduser()
		if path.is_file():
			password = path.read_text(encoding="utf-8").strip()
	if not email or not password:
		print("FAIL: missing UNORAG_ADMIN_EMAIL/PASSWORD", file=sys.stderr)
		return 2

	try:
		cases = load_gold_cases(GOLDS)
	except ValueError as exc:
		print(f"FAIL: {exc}", file=sys.stderr)
		return 2
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

	def cleanup_library() -> None:
		if KEEP_LIBRARY:
			print("== keep evaluation library", library_id)
			return
		try:
			cleanup_code, _ = client.json(
				"DELETE",
				f"/api/libraries/{library_id}",
				timeout=30,
			)
			print("== cleanup library", library_id, "http", cleanup_code)
		except Exception as exc:
			print(f"!! cleanup library failed: {exc}", file=sys.stderr)

	atexit.register(cleanup_library)

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
	reciprocal_ranks: list[float] = []
	document_hits = 0
	total_citations = 0
	cross_document_citations = 0
	latencies_ms: list[float] = []
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

		started = time.perf_counter()
		code, resp = client.json(
			"POST",
			"/api/rag/v1/ask",
			{"question": case["question"], "library_id": library_id},
			timeout=ASK_TIMEOUT_S,
		)
		latency_ms = round((time.perf_counter() - started) * 1000, 1)
		latencies_ms.append(latency_ms)
		answer = ""
		refused = None
		reason = None
		citations = []
		citation_files: list[str] = []
		if isinstance(resp, dict):
			answer = str(resp.get("answer") or "")
			refused = resp.get("refused")
			reason = resp.get("refuse_reason")
			citations = resp.get("citations") or []
		citation_files = [
			citation_file(citation)
			for citation in citations
			if isinstance(citation, dict)
		]
		target_file = Path(fname).name
		relevant_ranks = [
			rank
			for rank, citation_name in enumerate(citation_files, 1)
			if citation_name == target_file
		]
		reciprocal_rank = 1 / relevant_ranks[0] if relevant_ranks else 0.0
		reciprocal_ranks.append(reciprocal_rank)
		if relevant_ranks:
			document_hits += 1
		total_citations += len(citation_files)
		cross_document_citations += sum(
			1 for citation_name in citation_files if citation_name != target_file
		)
		missing = [f for f in facts if not fact_matches_answer(f, answer)]
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
				"citation_files": citation_files,
				"target_document_rank": relevant_ranks[0] if relevant_ranks else None,
				"reciprocal_rank": round(reciprocal_rank, 4),
				"latency_ms": latency_ms,
				"trace_id": (
					(resp.get("retrieval_debug") or {}).get("trace_id")
					if isinstance(resp, dict)
					else None
				),
				"missing_facts": missing,
			}
		)
		ask_rows.append(row)
		flag = "PASS" if ok else "FAIL"
		print(f"  [{i}/{len(cases)}] {flag} missing={missing[:3]} file={fname}")

	print("== ask negative cases", len(NEGATIVE_CASES))
	negative_rows = []
	negative_passed = 0
	for i, question in enumerate(NEGATIVE_CASES, 1):
		started = time.perf_counter()
		code, resp = client.json(
			"POST",
			"/api/rag/v1/ask",
			{"question": question, "library_id": library_id},
			timeout=ASK_TIMEOUT_S,
		)
		latency_ms = round((time.perf_counter() - started) * 1000, 1)
		latencies_ms.append(latency_ms)
		refused = isinstance(resp, dict) and resp.get("refused") is True
		ok = code == 200 and refused
		if ok:
			negative_passed += 1
		else:
			failed += 1
		negative_rows.append(
			{
				"i": i,
				"question": question,
				"ok": ok,
				"http": code,
				"refused": resp.get("refused") if isinstance(resp, dict) else None,
				"refuse_reason": (
					resp.get("refuse_reason") if isinstance(resp, dict) else None
				),
				"answer": (
					str(resp.get("answer") or "")[:500]
					if isinstance(resp, dict)
					else str(resp)[:500]
				),
				"citations": (
					len(resp.get("citations") or []) if isinstance(resp, dict) else 0
				),
				"latency_ms": latency_ms,
				"trace_id": (
					(resp.get("retrieval_debug") or {}).get("trace_id")
					if isinstance(resp, dict)
					else None
				),
			}
		)
		flag = "PASS" if ok else "FAIL"
		reason = resp.get("refuse_reason") if isinstance(resp, dict) else None
		print(f"  [N{i}/{len(NEGATIVE_CASES)}] {flag} reason={reason}")

	document_recall = document_hits / len(reciprocal_ranks) if reciprocal_ranks else 0
	document_mrr = statistics.fmean(reciprocal_ranks) if reciprocal_ranks else 0
	cross_document_rate = (
		cross_document_citations / total_citations if total_citations else 0
	)
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
			"evaluated_cases": len(reciprocal_ranks),
			"strict_evaluated_pass_rate": round(
				passed / len(reciprocal_ranks), 4
			)
			if reciprocal_ranks
			else 0,
			"ingest_blocked_cases": len(cases) - len(reciprocal_ranks),
			"ingest_completed": sum(1 for j in job_results.values() if j.get("status") == "completed"),
			"ingest_total": len(files),
			"document_recall_at_k": round(document_recall, 4),
			"document_mrr": round(document_mrr, 4),
			"cross_document_citation_rate": round(cross_document_rate, 4),
			"negative_cases": len(NEGATIVE_CASES),
			"negative_passed": negative_passed,
			"refusal_accuracy": round(
				negative_passed / len(NEGATIVE_CASES), 4
			),
			"latency_p50_ms": percentile(latencies_ms, 0.50),
			"latency_p95_ms": percentile(latencies_ms, 0.95),
			"latency_max_ms": round(max(latencies_ms), 1) if latencies_ms else None,
		},
		"cases": ask_rows,
		"negative_cases": negative_rows,
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
		f"- strict evaluated ask: **{passed}/{len(reciprocal_ranks)}** passed "
		f"({report['summary']['strict_evaluated_pass_rate']:.1%})",
		f"- document Recall@K: **{document_recall:.1%}**",
		f"- document MRR: **{document_mrr:.3f}**",
		f"- cross-document citation rate: **{cross_document_rate:.1%}**",
		f"- refusal accuracy: **{negative_passed}/{len(NEGATIVE_CASES)}**",
		f"- latency p50 / p95: **{percentile(latencies_ms, 0.50)} / {percentile(latencies_ms, 0.95)} ms**",
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
	lines.extend(["", "## Refusal failures", ""])
	negative_fails = [row for row in negative_rows if not row.get("ok")]
	if not negative_fails:
		lines.append("_none_")
	else:
		for row in negative_fails:
			lines.append(f"- Q: {row['question']}")
			lines.append(
				f"  - refused={row.get('refused')} reason={row.get('refuse_reason')}"
			)
			lines.append(f"  - answer: {(row.get('answer') or '')[:240]}")
	md_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
	latest_md.write_text(md_path.read_text(encoding="utf-8"), encoding="utf-8")

	print("== summary")
	print(json.dumps(report["summary"], ensure_ascii=False))
	print("report", json_path)
	print("report_md", md_path)
	return 0 if failed == 0 else 1


if __name__ == "__main__":
	raise SystemExit(main())
