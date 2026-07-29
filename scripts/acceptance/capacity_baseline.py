#!/usr/bin/env python3
"""Run a controlled capacity baseline through UnoRAG's public product boundary."""

from __future__ import annotations

import argparse
import concurrent.futures
import http.cookiejar
import json
import math
import os
import platform
import statistics
import sys
import tempfile
import threading
import time
import uuid
from collections import Counter
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable
from urllib.error import HTTPError, URLError
from urllib.request import HTTPCookieProcessor, Request, build_opener, urlopen


EXIT_FAIL = 1
EXIT_BLOCKED = 2
TERMINAL_JOB_STATUSES = {"completed", "failed", "dead", "cancelled"}
PASS_JOB_STATUS = "completed"


@dataclass(frozen=True)
class RequestResult:
    ok: bool
    status: int
    latency_ms: float
    quality_ok: bool
    refused: bool
    citations: int
    request_id: str | None
    error: str | None


def utc_now() -> str:
    return (
        datetime.now(timezone.utc)
        .replace(microsecond=0)
        .isoformat()
        .replace("+00:00", "Z")
    )


def percentile(values: list[float], fraction: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    index = max(0, math.ceil(fraction * len(ordered)) - 1)
    return round(ordered[index], 2)


def summarize(
    *,
    name: str,
    concurrency: int,
    results: list[RequestResult],
    wall_seconds: float,
) -> dict[str, Any]:
    latencies = [result.latency_ms for result in results]
    successes = [result for result in results if result.ok]
    quality_passes = [result for result in successes if result.quality_ok]
    status_counts = Counter(str(result.status) for result in results)
    errors = Counter(result.error for result in results if result.error)
    return {
        "name": name,
        "concurrency": concurrency,
        "requests": len(results),
        "successes": len(successes),
        "failures": len(results) - len(successes),
        "quality_passes": len(quality_passes),
        "quality_failures": len(successes) - len(quality_passes),
        "refused": sum(1 for result in successes if result.refused),
        "status_counts": dict(sorted(status_counts.items())),
        "error_counts": dict(errors.most_common(5)),
        "wall_seconds": round(wall_seconds, 3),
        "throughput_rps": (
            round(len(results) / wall_seconds, 3) if wall_seconds > 0 else None
        ),
        "latency_ms": {
            "min": round(min(latencies), 2) if latencies else None,
            "mean": round(statistics.fmean(latencies), 2) if latencies else None,
            "p50": percentile(latencies, 0.50),
            "p95": percentile(latencies, 0.95),
            "p99": percentile(latencies, 0.99),
            "max": round(max(latencies), 2) if latencies else None,
        },
    }


class CapacityClient:
    def __init__(self, base_url: str, timeout_seconds: float) -> None:
        self.base_url = base_url.rstrip("/")
        self.timeout_seconds = timeout_seconds
        self.cookie_jar = http.cookiejar.CookieJar()
        self.opener = build_opener(HTTPCookieProcessor(self.cookie_jar))
        self._cookie_lock = threading.Lock()

    @staticmethod
    def _decode_json(payload: bytes) -> dict[str, Any]:
        if not payload:
            return {}
        value = json.loads(payload.decode("utf-8"))
        if not isinstance(value, dict):
            raise ValueError("expected a JSON object")
        return value

    def session_json(
        self,
        method: str,
        path: str,
        body: dict[str, Any] | None = None,
        *,
        expected: set[int],
    ) -> tuple[int, dict[str, Any], dict[str, str]]:
        data = None if body is None else json.dumps(body).encode("utf-8")
        request = Request(
            f"{self.base_url}{path}",
            data=data,
            method=method,
            headers={"content-type": "application/json"} if data else {},
        )
        try:
            with self._cookie_lock:
                response = self.opener.open(request, timeout=self.timeout_seconds)
                status = response.status
                payload = response.read()
                headers = dict(response.headers.items())
        except HTTPError as exc:
            status = exc.code
            payload = exc.read()
            headers = dict(exc.headers.items())
        if status not in expected:
            excerpt = payload.decode("utf-8", errors="replace")[:500]
            raise RuntimeError(f"{method} {path} returned HTTP {status}: {excerpt}")
        return status, self._decode_json(payload), headers

    def session_cookie_header(self) -> str:
        with self._cookie_lock:
            return "; ".join(f"{cookie.name}={cookie.value}" for cookie in self.cookie_jar)

    def upload(
        self,
        *,
        library_id: str,
        file_path: Path,
        display_name: str,
        upload_filename: str | None = None,
    ) -> tuple[float, dict[str, Any]]:
        boundary = f"----unorag-capacity-{uuid.uuid4().hex}"
        filename = upload_filename or file_path.name
        file_bytes = file_path.read_bytes()
        parts = [
            (
                f"--{boundary}\r\n"
                'Content-Disposition: form-data; name="display_name"\r\n\r\n'
                f"{display_name}\r\n"
            ).encode(),
            (
                f"--{boundary}\r\n"
                f'Content-Disposition: form-data; name="file"; filename="{filename}"\r\n'
                "Content-Type: application/octet-stream\r\n\r\n"
            ).encode(),
            file_bytes,
            f"\r\n--{boundary}--\r\n".encode(),
        ]
        request = Request(
            f"{self.base_url}/api/libraries/{library_id}/documents",
            data=b"".join(parts),
            method="POST",
            headers={
                "content-type": f"multipart/form-data; boundary={boundary}",
                "cookie": self.session_cookie_header(),
            },
        )
        started = time.perf_counter()
        try:
            with urlopen(request, timeout=self.timeout_seconds) as response:
                status = response.status
                payload = response.read()
        except HTTPError as exc:
            status = exc.code
            payload = exc.read()
        elapsed_ms = (time.perf_counter() - started) * 1000
        if status != 202:
            excerpt = payload.decode("utf-8", errors="replace")[:500]
            raise RuntimeError(f"upload returned HTTP {status}: {excerpt}")
        return elapsed_ms, self._decode_json(payload)

    def wait_for_job(
        self,
        job_id: str,
        *,
        poll_seconds: float,
        timeout_seconds: float,
    ) -> tuple[float, dict[str, Any]]:
        started = time.perf_counter()
        deadline = started + timeout_seconds
        while time.perf_counter() < deadline:
            _, body, _ = self.session_json(
                "GET", f"/api/jobs/{job_id}", expected={200}
            )
            status = str(body.get("status") or "")
            if status in TERMINAL_JOB_STATUSES:
                return (time.perf_counter() - started) * 1000, body
            time.sleep(poll_seconds)
        raise TimeoutError(f"job {job_id} did not finish within {timeout_seconds}s")

    def delete_library_and_wait(
        self,
        library_id: str,
        *,
        poll_seconds: float,
        timeout_seconds: float,
    ) -> tuple[float, dict[str, Any]]:
        started = time.perf_counter()
        deadline = started + timeout_seconds
        last_body: dict[str, Any] = {}
        while time.perf_counter() < deadline:
            status, last_body, _ = self.session_json(
                "DELETE",
                f"/api/libraries/{library_id}",
                expected={200, 202},
            )
            if status == 200 or last_body.get("already_deleted") is True:
                return (time.perf_counter() - started) * 1000, last_body
            time.sleep(poll_seconds)
        raise TimeoutError(
            f"library {library_id} did not finish deletion within "
            f"{timeout_seconds}s; last response={last_body}"
        )


def run_parallel(
    *,
    count: int,
    concurrency: int,
    operation: Callable[[int], RequestResult],
) -> tuple[list[RequestResult], float]:
    started = time.perf_counter()
    with concurrent.futures.ThreadPoolExecutor(max_workers=concurrency) as executor:
        results = list(executor.map(operation, range(count)))
    return results, time.perf_counter() - started


def public_request(
    *,
    base_url: str,
    service_key: str,
    path: str,
    body: dict[str, Any],
    marker: str,
    timeout_seconds: float,
) -> RequestResult:
    request = Request(
        f"{base_url.rstrip('/')}{path}",
        data=json.dumps(body).encode("utf-8"),
        method="POST",
        headers={
            "authorization": f"Bearer {service_key}",
            "content-type": "application/json",
        },
    )
    started = time.perf_counter()
    try:
        with urlopen(request, timeout=timeout_seconds) as response:
            status = response.status
            payload = response.read()
            request_id = response.headers.get("x-request-id")
    except HTTPError as exc:
        status = exc.code
        payload = exc.read()
        request_id = exc.headers.get("x-request-id")
    except (TimeoutError, URLError, OSError) as exc:
        return RequestResult(
            ok=False,
            status=0,
            latency_ms=round((time.perf_counter() - started) * 1000, 2),
            quality_ok=False,
            refused=False,
            citations=0,
            request_id=None,
            error=type(exc).__name__,
        )

    latency_ms = round((time.perf_counter() - started) * 1000, 2)
    try:
        data = json.loads(payload.decode("utf-8"))
        citations = data.get("citations") if isinstance(data, dict) else None
        citations = citations if isinstance(citations, list) else []
        citation_blob = json.dumps(citations, ensure_ascii=False)
        refused = bool(data.get("refused")) if isinstance(data, dict) else False
        quality_ok = marker in citation_blob and not refused
        error = None
        if status < 200 or status >= 300:
            error_data = data.get("error", {}) if isinstance(data, dict) else {}
            error = str(error_data.get("code") or f"http_{status}")
    except (UnicodeDecodeError, json.JSONDecodeError):
        citations = []
        refused = False
        quality_ok = False
        error = "invalid_json"
    return RequestResult(
        ok=200 <= status < 300,
        status=status,
        latency_ms=latency_ms,
        quality_ok=quality_ok,
        refused=refused,
        citations=len(citations),
        request_id=request_id,
        error=error,
    )


def parse_stages(raw: str) -> list[tuple[int, int]]:
    stages: list[tuple[int, int]] = []
    for item in raw.split(","):
        try:
            concurrency_raw, count_raw = item.strip().split(":", 1)
            concurrency, count = int(concurrency_raw), int(count_raw)
        except ValueError as exc:
            raise argparse.ArgumentTypeError(
                "stages must use concurrency:requests pairs"
            ) from exc
        if concurrency < 1 or count < concurrency:
            raise argparse.ArgumentTypeError(
                "concurrency must be positive and requests >= concurrency"
            )
        stages.append((concurrency, count))
    return stages


def parser_report_summary(job: dict[str, Any]) -> dict[str, Any]:
    raw = job.get("parser_report")
    report = raw if isinstance(raw, dict) else {}
    raw_metrics = report.get("metrics")
    metrics = raw_metrics if isinstance(raw_metrics, dict) else {}
    raw_warnings = report.get("warnings")
    warnings = raw_warnings if isinstance(raw_warnings, list) else []
    parse_status = job.get("parse_status")
    status = parse_status if isinstance(parse_status, dict) else {}
    return {
        "backend": report.get("backend"),
        "parser": report.get("parser"),
        "mode": report.get("mode"),
        "partial": report.get("partial"),
        "route": metrics.get("route"),
        "parser_latency_ms": report.get("latency_ms"),
        "external_status": status.get("external_status"),
        "degraded": status.get("degraded"),
        "warnings": [str(item)[:300] for item in warnings[:5]],
    }


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument(
        "--base-url", default=os.getenv("UNORAG_BASE_URL", "http://localhost:3000")
    )
    result.add_argument(
        "--admin-email",
        default=os.getenv("UNORAG_ADMIN_EMAIL", "admin@example.com"),
    )
    result.add_argument(
        "--admin-password-env", default="UNORAG_ADMIN_PASSWORD", metavar="NAME"
    )
    result.add_argument(
        "--retrieve-stages", default="1:5,5:10,10:20,20:40", type=parse_stages
    )
    result.add_argument("--ask-stages", default="1:2,5:5,10:10,20:20", type=parse_stages)
    result.add_argument(
        "--lifecycle-concurrency", default="1,2,4", help="comma-separated upload fan-out"
    )
    result.add_argument("--job-timeout", type=float, default=300)
    result.add_argument("--request-timeout", type=float, default=65)
    result.add_argument("--poll-seconds", type=float, default=1)
    result.add_argument(
        "--mineru-file",
        type=Path,
        help="optional real PDF to measure as a single complex/OCR lifecycle job",
    )
    result.add_argument(
        "--output",
        type=Path,
        default=Path("scripts/acceptance/.capacity_last_run.json"),
    )
    return result


def lifecycle_stage(
    client: CapacityClient,
    library_id: str,
    fixture: Path,
    concurrency: int,
    args: argparse.Namespace,
) -> dict[str, Any]:
    def upload_and_wait(index: int) -> dict[str, Any]:
        accepted_ms, accepted = client.upload(
            library_id=library_id,
            file_path=fixture,
            display_name=f"Capacity lifecycle c{concurrency} #{index + 1}",
            upload_filename=f"capacity-c{concurrency}-{index + 1}-{uuid.uuid4().hex}.md",
        )
        job_id = str(accepted["job_id"])
        ready_ms, job = client.wait_for_job(
            job_id,
            poll_seconds=args.poll_seconds,
            timeout_seconds=args.job_timeout,
        )
        return {
            "accepted_ms": round(accepted_ms, 2),
            "ready_ms": round(accepted_ms + ready_ms, 2),
            "status": str(job.get("status") or ""),
            "stage": str(job.get("stage") or ""),
        }

    started = time.perf_counter()
    errors: list[str] = []
    results: list[dict[str, Any]] = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=concurrency) as executor:
        futures = [executor.submit(upload_and_wait, index) for index in range(concurrency)]
        for future in concurrent.futures.as_completed(futures):
            try:
                results.append(future.result())
            except Exception as exc:  # Report all jobs instead of aborting the batch.
                errors.append(f"{type(exc).__name__}: {exc}")
    wall_seconds = time.perf_counter() - started
    ready_values = [float(item["ready_ms"]) for item in results]
    accepted_values = [float(item["accepted_ms"]) for item in results]
    return {
        "name": "lifecycle",
        "concurrency": concurrency,
        "jobs": concurrency,
        "completed": sum(
            1 for item in results if item.get("status") == PASS_JOB_STATUS
        ),
        "failures": len(errors)
        + sum(1 for item in results if item.get("status") != PASS_JOB_STATUS),
        "status_counts": dict(Counter(item["status"] for item in results)),
        "wall_seconds": round(wall_seconds, 3),
        "jobs_per_second": round(concurrency / wall_seconds, 3),
        "accept_latency_ms": {
            "p50": percentile(accepted_values, 0.50),
            "p95": percentile(accepted_values, 0.95),
            "max": round(max(accepted_values), 2) if accepted_values else None,
        },
        "ready_latency_ms": {
            "p50": percentile(ready_values, 0.50),
            "p95": percentile(ready_values, 0.95),
            "max": round(max(ready_values), 2) if ready_values else None,
        },
        "errors": errors[:5],
    }


def main() -> int:
    args = parser().parse_args()
    password = os.getenv(args.admin_password_env)
    if not password:
        print(
            f"BLOCKED: {args.admin_password_env} is required and is never written to output",
            file=sys.stderr,
        )
        return EXIT_BLOCKED
    try:
        lifecycle_concurrency = [
            int(value) for value in args.lifecycle_concurrency.split(",")
        ]
        if not lifecycle_concurrency or min(lifecycle_concurrency) < 1:
            raise ValueError
    except ValueError:
        print("FAIL: --lifecycle-concurrency must contain positive integers", file=sys.stderr)
        return EXIT_FAIL

    client = CapacityClient(args.base_url, args.request_timeout)
    report: dict[str, Any] = {
        "schema_version": 1,
        "started_at": utc_now(),
        "base_url": args.base_url.rstrip("/"),
        "runner": {
            "hostname": platform.node(),
            "python": platform.python_version(),
            "platform": platform.platform(),
        },
        "configuration": {
            "retrieve_stages": args.retrieve_stages,
            "ask_stages": args.ask_stages,
            "lifecycle_concurrency": lifecycle_concurrency,
            "request_timeout_seconds": args.request_timeout,
            "job_timeout_seconds": args.job_timeout,
            "mineru_file": args.mineru_file.name if args.mineru_file else None,
        },
        "stages": {"retrieve": [], "ask": [], "lifecycle": []},
        "cleanup": {},
    }
    library_id: str | None = None
    service_key_id: str | None = None
    service_key: str | None = None
    overall_failures: list[str] = []

    try:
        print(f"Login and prepare isolated capacity library at {args.base_url}")
        client.session_json(
            "POST",
            "/api/auth/session",
            {"email": args.admin_email, "password": password},
            expected={200},
        )
        token = f"{int(time.time())}-{uuid.uuid4().hex[:8]}"
        _, library, _ = client.session_json(
            "POST",
            "/api/libraries",
            {"name": f"Capacity Baseline {token}"},
            expected={200, 201},
        )
        library_id = str(library["id"])
        report["library_id"] = library_id

        marker = f"CAPACITY_PROOF_{uuid.uuid4().hex.upper()}"
        with tempfile.TemporaryDirectory(prefix="unorag-capacity-") as tmp:
            fixture = Path(tmp) / "capacity-baseline.md"
            fixture.write_text(
                "# Capacity Baseline\n\n"
                f"Unique proof marker: `{marker}`.\n\n"
                "## Operations policy\n\n"
                "Priority incidents must be acknowledged within fifteen minutes. "
                "The escalation owner is the Northline operations desk.\n",
                encoding="utf-8",
            )
            accepted_ms, accepted = client.upload(
                library_id=library_id,
                file_path=fixture,
                display_name="Capacity baseline seed",
            )
            ready_ms, seed_job = client.wait_for_job(
                str(accepted["job_id"]),
                poll_seconds=args.poll_seconds,
                timeout_seconds=args.job_timeout,
            )
            if seed_job.get("status") != PASS_JOB_STATUS:
                raise RuntimeError(f"seed ingest ended as {seed_job.get('status')}")
            report["seed_ingest"] = {
                "accepted_ms": round(accepted_ms, 2),
                "ready_ms": round(accepted_ms + ready_ms, 2),
                "status": seed_job.get("status"),
            }

            _, key_body, _ = client.session_json(
                "POST",
                "/api/workspace/keys",
                {
                    "name": f"Capacity baseline {token}",
                    "scopes": ["ask", "retrieve"],
                    "library_ids": [library_id],
                },
                expected={201},
            )
            service_key_id = str(key_body["id"])
            service_key = str(key_body["key"])

            print("Warm up Retrieve and Ask")
            warmups = [
                (
                    "/api/v1/retrieve",
                    {
                        "query": f"What is the proof marker {marker}?",
                        "library_id": library_id,
                        "top_k": 6,
                    },
                ),
                (
                    "/api/v1/ask",
                    {
                        "question": f"What is the proof marker {marker}?",
                        "library_id": library_id,
                        "session_id": f"capacity-warmup-{uuid.uuid4().hex}",
                    },
                ),
            ]
            for path, body in warmups:
                warmup = public_request(
                    base_url=args.base_url,
                    service_key=service_key,
                    path=path,
                    body=body,
                    marker=marker,
                    timeout_seconds=args.request_timeout,
                )
                if not warmup.ok or not warmup.quality_ok:
                    raise RuntimeError(
                        f"warmup {path} failed status={warmup.status} "
                        f"quality_ok={warmup.quality_ok} error={warmup.error}"
                    )

            for concurrency, count in args.retrieve_stages:
                print(f"Retrieve c={concurrency} requests={count}")

                def retrieve_operation(_: int) -> RequestResult:
                    return public_request(
                        base_url=args.base_url,
                        service_key=service_key or "",
                        path="/api/v1/retrieve",
                        body={
                            "query": f"What is the proof marker {marker}?",
                            "library_id": library_id,
                            "top_k": 6,
                        },
                        marker=marker,
                        timeout_seconds=args.request_timeout,
                    )

                results, wall_seconds = run_parallel(
                    count=count,
                    concurrency=concurrency,
                    operation=retrieve_operation,
                )
                stage = summarize(
                    name="retrieve",
                    concurrency=concurrency,
                    results=results,
                    wall_seconds=wall_seconds,
                )
                report["stages"]["retrieve"].append(stage)
                if stage["failures"] or stage["quality_failures"]:
                    overall_failures.append(f"retrieve concurrency={concurrency}")

            for concurrency, count in args.ask_stages:
                print(f"Ask c={concurrency} requests={count}")

                def ask_operation(index: int) -> RequestResult:
                    return public_request(
                        base_url=args.base_url,
                        service_key=service_key or "",
                        path="/api/v1/ask",
                        body={
                            "question": f"What is the proof marker {marker}?",
                            "library_id": library_id,
                            "session_id": (
                                f"capacity-{concurrency}-{index}-{uuid.uuid4().hex}"
                            ),
                        },
                        marker=marker,
                        timeout_seconds=args.request_timeout,
                    )

                results, wall_seconds = run_parallel(
                    count=count,
                    concurrency=concurrency,
                    operation=ask_operation,
                )
                stage = summarize(
                    name="ask",
                    concurrency=concurrency,
                    results=results,
                    wall_seconds=wall_seconds,
                )
                report["stages"]["ask"].append(stage)
                if stage["failures"] or stage["quality_failures"]:
                    overall_failures.append(f"ask concurrency={concurrency}")

            for concurrency in lifecycle_concurrency:
                print(f"Lifecycle upload c={concurrency}")
                stage = lifecycle_stage(
                    client, library_id, fixture, concurrency, args
                )
                report["stages"]["lifecycle"].append(stage)
                if stage["failures"]:
                    overall_failures.append(f"lifecycle concurrency={concurrency}")

            if args.mineru_file:
                if not args.mineru_file.is_file():
                    raise FileNotFoundError(args.mineru_file)
                print(f"MinerU lifecycle file={args.mineru_file.name}")
                accepted_ms, accepted = client.upload(
                    library_id=library_id,
                    file_path=args.mineru_file,
                    display_name="Capacity MinerU probe",
                )
                ready_ms, job = client.wait_for_job(
                    str(accepted["job_id"]),
                    poll_seconds=args.poll_seconds,
                    timeout_seconds=args.job_timeout,
                )
                report["mineru_probe"] = {
                    "filename": args.mineru_file.name,
                    "bytes": args.mineru_file.stat().st_size,
                    "accepted_ms": round(accepted_ms, 2),
                    "ready_ms": round(accepted_ms + ready_ms, 2),
                    "status": job.get("status"),
                    "stage": job.get("stage"),
                    "parser": parser_report_summary(job),
                }
                if job.get("status") != PASS_JOB_STATUS:
                    overall_failures.append("mineru_probe")
    except Exception as exc:
        overall_failures.append("scenario")
        report["fatal_error"] = f"{type(exc).__name__}: {exc}"
        print(f"FAIL: {report['fatal_error']}", file=sys.stderr)
    finally:
        if service_key_id:
            try:
                client.session_json(
                    "DELETE",
                    f"/api/workspace/keys/{service_key_id}",
                    expected={200, 204},
                )
                report["cleanup"]["service_key"] = "deleted"
            except Exception as exc:
                report["cleanup"]["service_key"] = f"failed: {type(exc).__name__}"
                overall_failures.append("cleanup_service_key")
        if library_id:
            try:
                delete_ms, delete_body = client.delete_library_and_wait(
                    library_id,
                    poll_seconds=args.poll_seconds,
                    timeout_seconds=args.job_timeout,
                )
                report["cleanup"]["library"] = {
                    "status": "deleted",
                    "latency_ms": round(delete_ms, 2),
                    "already_deleted": bool(delete_body.get("already_deleted")),
                }
            except Exception as exc:
                report["cleanup"]["library"] = f"failed: {type(exc).__name__}"
                overall_failures.append("cleanup_library")

    report["finished_at"] = utc_now()
    report["result"] = "PASS" if not overall_failures else "FAIL"
    report["failures"] = overall_failures
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    try:
        args.output.chmod(0o600)
    except OSError:
        pass
    print(f"{report['result']}: report written to {args.output}")
    return 0 if report["result"] == "PASS" else EXIT_FAIL


if __name__ == "__main__":
    raise SystemExit(main())
