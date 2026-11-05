import asyncio
from contextlib import redirect_stderr, redirect_stdout
from copy import deepcopy
import io
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import ragas_offline as evaluation
import httpx

FIXTURE = Path(__file__).parent / "fixtures/sample-v1.jsonl"
ROW = json.loads(FIXTURE.read_text())


def full_row():
    row = deepcopy(ROW)
    row["context_scope"] = "full_retrieval"
    row["retrieval"] = {"stage": "ask_base_retrieval", "complete": True, "ordered": True,
                        "query": row["question"], "attempt": 1}
    return row


class DataTests(unittest.TestCase):
    def load(self, rows, **kwargs):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "input.jsonl"
            path.write_text("\n".join(json.dumps(row) for row in rows) + "\n")
            return evaluation.load_samples(path, **kwargs)

    def test_fixture_validates_without_judge(self):
        rows, digest = evaluation.load_samples(FIXTURE)
        self.assertEqual(rows, [ROW])
        self.assertEqual(len(digest), 64)
        with patch.object(evaluation, "execute", side_effect=AssertionError("must not call judge")):
            with redirect_stdout(io.StringIO()) as output:
                self.assertEqual(evaluation.main([str(FIXTURE)]), 0)
            self.assertIn("No judge called", output.getvalue())

    def test_schema_bounds_provenance_and_duplicates(self):
        for change in ({"schema_version": 2}, {"response": " "}, {"question": "x" * 32769},
                       {"retrieved_contexts": "snippet"}, {"citations": ["secret"]},
                       {"context_scope": "full_retrieval"}, {"reference": ""},
                       {"context_scope": "unavailable"}):
            with self.subTest(change=list(change)):
                with self.assertRaises(evaluation.EvaluationError):
                    self.load([{**ROW, **change}])
        with self.assertRaisesRegex(evaluation.EvaluationError, "duplicate_sample"):
            self.load([ROW, ROW])
        with self.assertRaisesRegex(evaluation.EvaluationError, "sample_budget"):
            self.load([ROW, {**ROW, "case_id": "other"}], max_samples=1)
        with self.assertRaisesRegex(evaluation.EvaluationError, "mixed_run"):
            self.load([ROW, {**ROW, "case_id": "other", "run_id": "other"}])

    def test_invalid_json_and_cli_errors_are_redacted(self):
        for value in ('{"secret":NaN}', '{"a":1,"a":2}', "not-json-secret"):
            with self.assertRaises(evaluation.EvaluationError):
                evaluation.parse_json(value)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "sensitive.jsonl"
            path.write_text("sensitive-question-secret-key")
            with redirect_stderr(io.StringIO()) as output:
                self.assertEqual(evaluation.main([str(path)]), 2)
            self.assertNotIn("sensitive-question-secret-key", output.getvalue())

    def test_external_judge_requires_opt_in_and_secure_url(self):
        self.assertTrue(evaluation.judge_url("http://127.0.0.1:11434/v1", False)[1])
        self.assertTrue(evaluation.judge_url("http://[::1]:11434/v1", False)[1])
        for url, allow in (("https://judge.example/v1", False), ("http://judge.example/v1", True),
                           ("https://key:secret@judge.example/v1", True),
                           ("https://judge.example/v1?api_key=secret", True),
                           ("file:///v1", True)):
            with self.assertRaises(evaluation.EvaluationError):
                evaluation.judge_url(url, allow)
        self.assertFalse(evaluation.judge_url("https://judge.example/v1", True)[1])
        for limits in (evaluation.Limits(concurrency=5), evaluation.Limits(run_timeout=float("nan")),
                       evaluation.Limits(max_requests=0)):
            with self.assertRaises(evaluation.EvaluationError):
                limits.validate()


class FakeMetric:
    def __init__(self, value=0.5, error=None, delay=0):
        self.value, self.error, self.delay = value, error, delay
        self.calls = []

    async def ascore(self, **kwargs):
        self.calls.append(kwargs)
        if self.delay:
            await asyncio.sleep(self.delay)
        if self.error:
            raise self.error
        return SimpleNamespace(value=self.value)


class ScoringTests(unittest.IsolatedAsyncioTestCase):
    async def test_faithfulness_uses_actual_generation_input_not_discarded_retrieval(self):
        row = full_row()
        row["retrieved_contexts"] = ["Discarded candidate supports the generated claim."]
        row["generation_contexts"] = ["[1] Selected title\nHeading\nSelected evidence does not support that claim."]
        metrics = {name: FakeMetric() for name in evaluation.METRICS}
        await evaluation.score_samples([row], metrics, evaluation.Limits())
        self.assertEqual(metrics["faithfulness"].calls[0]["retrieved_contexts"], row["generation_contexts"])
        self.assertEqual(metrics["context_recall"].calls[0]["retrieved_contexts"], row["retrieved_contexts"])
        row["generation_contexts"] = []
        metrics = {name: FakeMetric() for name in evaluation.METRICS}
        report = await evaluation.score_samples([row], metrics, evaluation.Limits())
        self.assertEqual(report["status"], "incomplete")
        self.assertEqual(report["rows"][0]["metrics"]["faithfulness"]["code"], "generation_context_not_available")
        self.assertEqual(metrics["faithfulness"].calls, [])

    async def test_reference_and_scope_determine_metrics(self):
        metrics = {name: FakeMetric() for name in evaluation.METRICS}
        report = await evaluation.score_samples([full_row()], metrics, evaluation.Limits())
        self.assertEqual(report["status"], "completed")
        self.assertTrue(report["informational_only"])
        self.assertEqual(report["release_gate"], "not_evaluated")
        self.assertEqual(len(metrics["context_recall"].calls), 1)
        self.assertEqual(len(metrics["context_utilization"].calls), 0)
        row = full_row()
        row["reference"] = None
        metrics = {name: FakeMetric() for name in evaluation.METRICS}
        report = await evaluation.score_samples([row], metrics, evaluation.Limits())
        self.assertEqual(report["rows"][0]["metrics"]["context_recall"]["code"], "reference_not_available")
        self.assertEqual(len(metrics["context_utilization"].calls), 1)
        for scope in ("provided", "selected", "unavailable"):
            row = deepcopy(ROW)
            row["context_scope"] = scope
            if scope == "unavailable":
                row["retrieved_contexts"] = []
            metrics = {name: FakeMetric() for name in evaluation.METRICS}
            report = await evaluation.score_samples([row], metrics, evaluation.Limits())
            self.assertEqual(report["status"], "incomplete")
            self.assertEqual(report["summary"]["context_recall"]["mean"], None)
            self.assertEqual(len(metrics["context_recall"].calls), 0)
            self.assertEqual(len(metrics["response_relevance"].calls), 1)

    async def test_errors_and_nonfinite_scores_are_not_passes_or_omitted(self):
        for metric in (FakeMetric(value=float("nan")), FakeMetric(value=2),
                       FakeMetric(error=RuntimeError("PRIVATE QUESTION API KEY")),
                       FakeMetric(error=asyncio.TimeoutError())):
            metrics = {name: FakeMetric() for name in evaluation.METRICS}
            metrics["faithfulness"] = metric
            report = await evaluation.score_samples([full_row()], metrics, evaluation.Limits())
            self.assertEqual(report["status"], "error")
            self.assertEqual(report["summary"]["faithfulness"]["errors"], 1)
            self.assertIsNone(report["summary"]["faithfulness"]["mean"])
            self.assertNotIn("PRIVATE QUESTION API KEY", json.dumps(report))
            self.assertNotIn(ROW["question"], json.dumps(report))

    async def test_total_timeout_marks_every_unfinished_metric(self):
        metrics = {name: FakeMetric(delay=5) for name in evaluation.METRICS}
        report = await evaluation.score_samples([full_row()], metrics, evaluation.Limits(run_timeout=1))
        self.assertEqual(report["status"], "error")
        self.assertTrue(all(value["code"] == "run_timeout" for value in report["rows"][0]["metrics"].values()))


class TransportTests(unittest.IsolatedAsyncioTestCase):
    async def test_actual_requests_enforce_request_input_and_token_budgets(self):
        sent = []

        async def handler(request):
            sent.append(request)
            return httpx.Response(200, json={"ok": True})

        transport = evaluation.BudgetTransport("https://judge.example/v1", evaluation.Limits(max_requests=1), httpx.MockTransport(handler))
        async with httpx.AsyncClient(transport=transport) as client:
            body = {"messages": [], "max_tokens": 64}
            await client.post("https://judge.example/v1/chat/completions", json=body)
            with self.assertRaisesRegex(evaluation.EvaluationError, "request_budget"):
                await client.post("https://judge.example/v1/chat/completions", json=body)
            with self.assertRaisesRegex(evaluation.EvaluationError, "unbounded"):
                await client.post("https://judge.example/v1/chat/completions", json={"max_tokens": 99999})
            with self.assertRaisesRegex(evaluation.EvaluationError, "destination"):
                await client.post("https://other.example/v1/embeddings", json={})
        self.assertEqual(len(sent), 1)
        transport = evaluation.BudgetTransport("https://judge.example/v1", evaluation.Limits(max_input_bytes=1), httpx.MockTransport(handler))
        async with httpx.AsyncClient(transport=transport) as client:
            with self.assertRaisesRegex(evaluation.EvaluationError, "input_budget"):
                await client.post("https://judge.example/v1/embeddings", json={"input": "too large"})

    async def test_redirects_rejected_and_transport_concurrency_bounded(self):
        active = peak = 0

        async def handler(request):
            nonlocal active, peak
            active += 1
            peak = max(peak, active)
            await asyncio.sleep(0.01)
            active -= 1
            return httpx.Response(307, headers={"location": "https://other.example/v1"})

        transport = evaluation.BudgetTransport("https://judge.example/v1", evaluation.Limits(concurrency=1), httpx.MockTransport(handler))
        async with httpx.AsyncClient(transport=transport) as client:
            results = await asyncio.gather(*(client.post("https://judge.example/v1/embeddings", json={}) for _ in range(3)), return_exceptions=True)
        self.assertEqual(peak, 1)
        self.assertTrue(all(isinstance(result, evaluation.EvaluationError) for result in results))

    async def test_installed_ragas_collections_api_with_mocked_http_not_real_judging(self):
        from openai import AsyncOpenAI
        calls = []
        outputs = {
            "StatementGeneratorOutput": {"statements": [ROW["response"]]},
            "NLIStatementOutput": {"statements": [{"statement": ROW["response"], "reason": "fixture", "verdict": 1}]},
            "AnswerRelevanceOutput": {"question": ROW["question"], "noncommittal": 0},
            "ContextPrecisionOutput": {"reason": "fixture", "verdict": 1},
            "ContextRecallOutput": {"classifications": [{"statement": ROW["response"], "reason": "fixture", "attributed": 1}]},
        }

        async def handler(request):
            body = json.loads(request.content)
            calls.append(request.url.path)
            if request.url.path.endswith("/embeddings"):
                inputs = body["input"] if isinstance(body["input"], list) else [body["input"]]
                return httpx.Response(200, json={"object": "list", "model": "fixture", "data": [
                    {"object": "embedding", "index": index, "embedding": [1.0, 0.0]} for index, _ in enumerate(inputs)],
                    "usage": {"prompt_tokens": 1, "total_tokens": 1}})
            # Ragas 0.4.3's Instructor adapter uses JSON mode, not tool calls.
            name = next(name for name in outputs if name in body["messages"][0]["content"])
            output = outputs[name]
            return httpx.Response(200, json={"id": "fixture", "object": "chat.completion", "created": 1,
                "model": "fixture", "choices": [{"index": 0, "finish_reason": "stop", "message": {
                    "role": "assistant", "content": json.dumps(output)}}],
                "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}})

        limits = evaluation.Limits()
        transport = evaluation.BudgetTransport("http://127.0.0.1:1/v1", limits, httpx.MockTransport(handler))
        async with httpx.AsyncClient(transport=transport) as http:
            async with AsyncOpenAI(api_key="synthetic-no-real-key", base_url="http://127.0.0.1:1/v1", http_client=http, max_retries=0) as client:
                metrics = evaluation.make_metrics(client, "fixture-model", "fixture-embeddings", limits)
                self.assertTrue(type(metrics["faithfulness"]).__module__.startswith("ragas.metrics.collections"))
                report = await evaluation.score_samples([full_row()], metrics, limits)
        self.assertEqual(report["status"], "completed", report)
        self.assertGreaterEqual(len(calls), 8)
        self.assertEqual(report["summary"]["faithfulness"]["mean"], 1.0)
        self.assertEqual(report["summary"]["response_relevance"]["mean"], 1.0)


if __name__ == "__main__":
    unittest.main()
