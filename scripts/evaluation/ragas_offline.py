"""Optional, explicitly executed offline Ragas scoring; not a product service."""

import argparse
import asyncio
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
import hashlib
import importlib.metadata
import json
import logging
import math
import os
from pathlib import Path
import sys
import tempfile
from urllib.parse import urlsplit

# Must precede any Ragas/LangChain import. No tracing or persistent prompt cache.
os.environ["RAGAS_DO_NOT_TRACK"] = "true"
os.environ["LANGCHAIN_TRACING_V2"] = "false"
os.environ["LANGSMITH_TRACING"] = "false"

import httpx
from jsonschema import Draft202012Validator

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
METRICS = ("faithfulness", "response_relevance", "context_precision", "context_recall", "context_utilization")


class EvaluationError(Exception):
    """Only fixed, non-sensitive codes may escape the evaluation boundary."""


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise EvaluationError("duplicate_json_key")
        result[key] = value
    return result


def reject_constant(_):
    raise EvaluationError("nonfinite_json")


def parse_json(value):
    try:
        return json.loads(value, object_pairs_hook=unique_object, parse_constant=reject_constant)
    except (ValueError, UnicodeError):
        raise EvaluationError("invalid_json") from None


def load_samples(path, max_samples=20):
    if not 1 <= max_samples <= 100:
        raise EvaluationError("invalid_sample_budget")
    with Path(path).open("rb") as handle:
        raw = handle.read(8_000_001)
    if len(raw) > 8_000_000:
        raise EvaluationError("input_too_large")
    validator = Draft202012Validator(parse_json((HERE / "sample-v1.schema.json").read_bytes()))
    rows, seen = [], set()
    for line in raw.splitlines():
        if not line.strip():
            raise EvaluationError("blank_jsonl_row")
        row = parse_json(line)
        if not validator.is_valid(row):
            raise EvaluationError("invalid_sample_schema")
        full = row["context_scope"] == "full_retrieval"
        if full != (row["retrieval"] is not None):
            raise EvaluationError("invalid_context_provenance")
        if row["context_scope"] == "unavailable" and row["retrieved_contexts"]:
            raise EvaluationError("invalid_context_provenance")
        provenance = row["provenance"]
        if (provenance["generation_context"] == "unavailable" and row["generation_contexts"] or
                provenance["generation_context"] == "server_model_input" and provenance["response"] != "server_stream_sha256" or
                provenance["response"] == "server_stream_sha256" and
                row["response_sha256"] != hashlib.sha256(row["response"].encode()).hexdigest()):
            raise EvaluationError("invalid_generation_provenance")
        key = (row["run_id"], row["case_id"])
        if key in seen:
            raise EvaluationError("duplicate_sample")
        seen.add(key)
        rows.append(row)
        if len(rows) > max_samples:
            raise EvaluationError("sample_budget_exceeded")
    if not rows:
        raise EvaluationError("empty_dataset")
    fingerprints = {json.dumps(row["build_fingerprint"], sort_keys=True) for row in rows}
    if len({row["run_id"] for row in rows}) != 1 or len(fingerprints) != 1:
        raise EvaluationError("mixed_run_fingerprints")
    return rows, hashlib.sha256(raw).hexdigest()


@dataclass(frozen=True)
class Limits:
    max_samples: int = 20
    concurrency: int = 1
    max_requests: int = 200
    max_input_bytes: int = 2_000_000
    max_output_tokens: int = 1024
    request_timeout: float = 30
    metric_timeout: float = 90
    run_timeout: float = 600

    def validate(self):
        ranges = {"max_samples": (1, 100), "concurrency": (1, 4),
                  "max_requests": (1, 2000), "max_input_bytes": (1, 20_000_000),
                  "max_output_tokens": (64, 4096), "request_timeout": (1, 120),
                  "metric_timeout": (1, 300), "run_timeout": (1, 3600)}
        for name, (lower, upper) in ranges.items():
            value = getattr(self, name)
            if not math.isfinite(value) or not lower <= value <= upper:
                raise EvaluationError("invalid_limits")


def judge_url(value, allow_external):
    try:
        parsed = urlsplit(value)
        port = parsed.port
    except ValueError:
        raise EvaluationError("invalid_judge_url") from None
    if (parsed.scheme not in ("https", "http") or not parsed.hostname or
            parsed.username or parsed.password or parsed.query or parsed.fragment or
            not parsed.path.rstrip("/").endswith("/v1") or port == 0):
        raise EvaluationError("invalid_judge_url")
    local = parsed.hostname in ("127.0.0.1", "::1", "localhost")
    if not local and not allow_external:
        raise EvaluationError("external_judge_requires_opt_in")
    if not local and parsed.scheme != "https":
        raise EvaluationError("external_judge_requires_https")
    return value.rstrip("/"), local


class BudgetTransport(httpx.AsyncBaseTransport):
    """Enforce budgets on actual HTTP attempts, including library-internal retries."""

    def __init__(self, base_url, limits, inner=None):
        self.base = httpx.URL(base_url)
        self.limits = limits
        self.inner = inner if inner is not None else httpx.AsyncHTTPTransport(retries=0)
        self.semaphore = asyncio.Semaphore(limits.concurrency)
        self.requests = 0
        self.input_bytes = 0

    async def handle_async_request(self, request):
        if ((request.url.scheme, request.url.host, request.url.port) !=
                (self.base.scheme, self.base.host, self.base.port) or
                request.url.path not in (self.base.path.rstrip("/") + "/chat/completions",
                                         self.base.path.rstrip("/") + "/embeddings") or
                request.method != "POST" or request.url.query):
            raise EvaluationError("unexpected_judge_destination")
        body = parse_json(await request.aread())
        if request.url.path.endswith("/chat/completions"):
            tokens = body.get("max_completion_tokens", body.get("max_tokens"))
            if (type(tokens) is not int or not 1 <= tokens <= self.limits.max_output_tokens or
                    body.get("n", 1) != 1 or body.get("stream", False)):
                raise EvaluationError("unbounded_judge_request")
        size = len(request.content)
        async with self.semaphore:
            if self.requests >= self.limits.max_requests:
                raise EvaluationError("request_budget_exceeded")
            if self.input_bytes + size > self.limits.max_input_bytes:
                raise EvaluationError("input_budget_exceeded")
            self.requests += 1
            self.input_bytes += size
            response = await self.inner.handle_async_request(request)
            # Never follow redirects, including redirects to another judge origin.
            if 300 <= response.status_code < 400:
                await response.aclose()
                raise EvaluationError("judge_redirect_rejected")
            return response

    async def aclose(self):
        await self.inner.aclose()


def make_metrics(client, model, embedding_model, limits):
    from ragas.embeddings.base import embedding_factory
    from ragas.llms import llm_factory
    from ragas.metrics.collections import (AnswerRelevancy, ContextPrecision,
                                          ContextRecall, ContextUtilization, Faithfulness)

    llm = llm_factory(model, client=client, adapter="instructor", temperature=0,
                      max_tokens=limits.max_output_tokens, max_retries=1)
    embeddings = embedding_factory("openai", model=embedding_model, client=client)
    return {"faithfulness": Faithfulness(llm=llm),
            "response_relevance": AnswerRelevancy(llm=llm, embeddings=embeddings, strictness=3),
            "context_precision": ContextPrecision(llm=llm),
            "context_recall": ContextRecall(llm=llm),
            "context_utilization": ContextUtilization(llm=llm)}


def metric_arguments(row, name):
    args = {"user_input": row["question"]}
    if name in ("faithfulness", "response_relevance", "context_utilization"):
        args["response"] = row["response"]
    if name != "response_relevance":
        args["retrieved_contexts"] = row["generation_contexts"] if name == "faithfulness" else row["retrieved_contexts"]
    if name in ("context_precision", "context_recall"):
        args["reference"] = row["reference"]
    return args


def skip_reason(row, name):
    if name == "response_relevance":
        return None
    if name == "faithfulness":
        return None if row["generation_contexts"] else "generation_context_not_available"
    if name in ("context_precision", "context_recall", "context_utilization"):
        if row["context_scope"] != "full_retrieval":
            return "full_retrieval_not_captured"
        if name == "context_utilization" and row["reference"] is not None:
            return "reference_precision_used"
        if name in ("context_precision", "context_recall") and row["reference"] is None:
            return "reference_not_available"
    if not row["retrieved_contexts"]:
        return "contexts_not_available"
    return None


async def score_samples(rows, metrics, limits):
    limits.validate()
    results = [{"case_id": row["case_id"], "request_id": row["request_id"],
                "context_scope": row["context_scope"], "provenance": row["provenance"], "metrics": {
                    name: {"status": "error", "code": "not_run", "value": None} for name in METRICS}}
               for row in rows]
    semaphore = asyncio.Semaphore(limits.concurrency)

    async def score_row(index, row):
        async with semaphore:
            for name in METRICS:
                reason = skip_reason(row, name)
                if reason:
                    results[index]["metrics"][name] = {"status": "skipped", "code": reason, "value": None}
                    continue
                try:
                    score = await asyncio.wait_for(metrics[name].ascore(**metric_arguments(row, name)),
                                                   timeout=limits.metric_timeout)
                    value = float(score.value)
                    lower = -1 if name == "response_relevance" else 0
                    if not math.isfinite(value) or not lower <= value <= 1:
                        raise EvaluationError("invalid_metric_score")
                    result = {"status": "ok", "value": value}
                except asyncio.TimeoutError:
                    result = {"status": "error", "code": "metric_timeout", "value": None}
                except EvaluationError as error:
                    result = {"status": "error", "code": str(error), "value": None}
                except Exception:
                    # Provider exceptions can contain full prompts, request bodies and keys.
                    result = {"status": "error", "code": "judge_or_metric_error", "value": None}
                results[index]["metrics"][name] = result

    try:
        async with asyncio.timeout(limits.run_timeout):
            await asyncio.gather(*(score_row(index, row) for index, row in enumerate(rows)))
    except asyncio.TimeoutError:
        for result in results:
            for metric in result["metrics"].values():
                if metric.get("code") == "not_run":
                    metric["code"] = "run_timeout"
    summary = {}
    for name in METRICS:
        values = [result["metrics"][name]["value"] for result in results if result["metrics"][name]["status"] == "ok"]
        summary[name] = {"scored": len(values), "total": len(rows),
                         "mean": sum(values) / len(values) if values else None,
                         "errors": sum(result["metrics"][name]["status"] == "error" for result in results)}
    error = any(metric["status"] == "error" for result in results for metric in result["metrics"].values())
    incomplete = any(row["context_scope"] != "full_retrieval" or not row["retrieved_contexts"] or not row["generation_contexts"] for row in rows)
    return {"status": "error" if error else "incomplete" if incomplete else "completed",
            "informational_only": True, "release_gate": "not_evaluated",
            "rows": results, "summary": summary}


def write_report(report):
    directory = ROOT
    for component in (".unorag", "evaluation"):
        directory = directory / component
        directory.mkdir(mode=0o700, exist_ok=True)
        if directory.is_symlink() or not directory.is_dir():
            raise EvaluationError("unsafe_output_directory")
        directory.chmod(0o700)
    path = directory / ("semantic-" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S") + "-" + os.urandom(4).hex() + ".json")
    fd, temporary = tempfile.mkstemp(prefix=".pending-", dir=directory)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(report, handle, allow_nan=False, ensure_ascii=True, indent=2)
            handle.write("\n")
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)
    return path


async def execute(rows, input_digest, args, limits):
    from openai import AsyncOpenAI

    base_url, local = judge_url(args.judge_base_url, args.allow_external_judge)
    key = os.environ.get("UNORAG_RAGAS_API_KEY", "")
    if not local and not key:
        raise EvaluationError("judge_key_required")
    if not args.judge_model or not args.embedding_model:
        raise EvaluationError("explicit_models_required")
    # Third-party libraries may log model payloads on validation errors.
    logging.disable(logging.CRITICAL)
    transport = BudgetTransport(base_url, limits)
    async with httpx.AsyncClient(transport=transport, timeout=limits.request_timeout,
                                follow_redirects=False, trust_env=False) as http_client:
        async with AsyncOpenAI(base_url=base_url, api_key=key or "local-no-key", max_retries=0,
                               timeout=limits.request_timeout, http_client=http_client) as client:
            metrics = make_metrics(client, args.judge_model, args.embedding_model, limits)
            report = await score_samples(rows, metrics, limits)
    report.update({"schema_version": 1, "evaluated_at": datetime.now(timezone.utc).isoformat(),
                   "input_sha256": input_digest, "run_id": rows[0]["run_id"],
                   "build_fingerprint": rows[0]["build_fingerprint"],
                   "judge": {"model": args.judge_model, "embedding_model": args.embedding_model,
                             "endpoint_sha256": hashlib.sha256(base_url.encode()).hexdigest(),
                             "external_opt_in": args.allow_external_judge, "local_endpoint": local},
                   "tool_fingerprint": {"ragas": importlib.metadata.version("ragas"),
                                        "uv_lock_sha256": hashlib.sha256((HERE / "uv.lock").read_bytes()).hexdigest(),
                                        "runner_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
                                        "schema_sha256": hashlib.sha256((HERE / "sample-v1.schema.json").read_bytes()).hexdigest()},
                   "limits": asdict(limits),
                   "usage": {"http_requests": transport.requests, "request_body_bytes": transport.input_bytes,
                             "max_completion_tokens_per_request": limits.max_output_tokens}})
    write_report(report)
    return 0 if report["status"] == "completed" else 2


def main(argv=None):
    parser = argparse.ArgumentParser(description="Offline Ragas diagnostics. Default: local validation only, no judge calls.")
    parser.add_argument("input", type=Path)
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--allow-external-judge", action="store_true")
    parser.add_argument("--judge-base-url", default="http://127.0.0.1:11434/v1")
    parser.add_argument("--judge-model")
    parser.add_argument("--embedding-model")
    for name, value in asdict(Limits()).items():
        parser.add_argument("--" + name.replace("_", "-"), type=type(value), default=value)
    args = parser.parse_args(argv)
    try:
        limits = Limits(**{name: getattr(args, name) for name in asdict(Limits())})
        limits.validate()
        rows, input_digest = load_samples(args.input, limits.max_samples)
        if not args.execute:
            print(f"Validated {len(rows)} samples. No judge called; no semantic scores produced.")
            return 0
        code = asyncio.run(execute(rows, input_digest, args, limits))
        print("Semantic diagnostics written under .unorag/evaluation; informational only.")
        return code
    except Exception:
        print("Offline evaluation failed. Check input schema, explicit judge opt-in, models, and budgets. No pass asserted.", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
