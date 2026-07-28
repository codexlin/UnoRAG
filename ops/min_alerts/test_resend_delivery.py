"""Unit tests for Resend email delivery in ops/min_alerts (HTTP mocked)."""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

import check as min_alerts  # noqa: E402


SAMPLE_PAYLOAD = {
	"version": "unorag.min_alerts/1",
	"status": "firing",
	"alert_name": "health.qdrant_ask",
	"namespace": "unorag",
	"fingerprint": "health.qdrant_ask:unorag",
	"severity": "warning",
	"starts_at": "2026-07-28T00:00:00Z",
	"ends_at": None,
	"labels": {"namespace": "unorag"},
	"annotations": {"reasons": ["qdrant_ok=false"]},
	"workspace_id": "ws-1",
	"organization_id": "",
	"trace_id": "tr-1",
	"job_id": "",
	"request_id": "tr-1",
	"worker_id": "",
}


def test_format_alert_email_contains_locators() -> None:
	subject, text = min_alerts.format_alert_email(SAMPLE_PAYLOAD)
	assert "firing" in subject
	assert "health.qdrant_ask" in subject
	assert "workspace_id: ws-1" in text
	assert "trace_id: tr-1" in text


def test_post_resend_email_success(monkeypatch: pytest.MonkeyPatch) -> None:
	captured: dict[str, Any] = {}

	def fake_http_json(url, method="GET", body=None, headers=None, timeout=8.0, cookie_jar=None):
		captured["url"] = url
		captured["method"] = method
		captured["headers"] = headers or {}
		captured["body"] = json.loads(body.decode("utf-8")) if body else None
		return 200, {}, {"id": "re_test_1"}

	monkeypatch.setattr(min_alerts, "http_json", fake_http_json)
	out = min_alerts.post_resend_email(
		api_key="re_test",
		from_addr="alerts@example.com",
		to_addrs=["ops@example.com"],
		payload=SAMPLE_PAYLOAD,
	)
	assert out["ok"] is True
	assert out["channel"] == "resend"
	assert out["resend_id"] == "re_test_1"
	assert captured["method"] == "POST"
	assert captured["headers"]["Authorization"] == "Bearer re_test"
	assert captured["body"]["from"] == "alerts@example.com"
	assert captured["body"]["to"] == ["ops@example.com"]
	assert "firing" in captured["body"]["subject"]


def test_post_resend_email_http_failure_is_soft(monkeypatch: pytest.MonkeyPatch) -> None:
	def fake_http_json(*_a, **_k):
		return 401, {}, {"message": "invalid api key"}

	monkeypatch.setattr(min_alerts, "http_json", fake_http_json)
	out = min_alerts.post_resend_email(
		api_key="bad",
		from_addr="alerts@example.com",
		to_addrs=["ops@example.com"],
		payload=SAMPLE_PAYLOAD,
	)
	assert out["ok"] is False
	assert out["http_status"] == 401


def test_post_resend_email_incomplete_config() -> None:
	out = min_alerts.post_resend_email(
		api_key="",
		from_addr="alerts@example.com",
		to_addrs=["ops@example.com"],
		payload=SAMPLE_PAYLOAD,
	)
	assert out["ok"] is False
	assert "incomplete" in out["error"]


def test_deliver_resend_only(monkeypatch: pytest.MonkeyPatch) -> None:
	monkeypatch.setattr(
		min_alerts,
		"post_resend_email",
		lambda **_k: {"ok": True, "channel": "resend", "http_status": 200},
	)
	delivery = min_alerts.deliver_notification(
		SAMPLE_PAYLOAD,
		webhook_url="",
		resend={
			"api_key": "re_x",
			"from_addr": "a@example.com",
			"to_addrs": ["b@example.com"],
		},
		dry_run=False,
	)
	assert delivery["ok"] is True
	assert delivery["channels"][0]["channel"] == "resend"


def test_deliver_no_channel() -> None:
	delivery = min_alerts.deliver_notification(
		SAMPLE_PAYLOAD,
		webhook_url="",
		resend={"api_key": "", "from_addr": "", "to_addrs": []},
		dry_run=False,
	)
	assert delivery["ok"] is False
	assert "no notify channel" in delivery["error"]


def test_deliver_dry_run_skips() -> None:
	delivery = min_alerts.deliver_notification(
		SAMPLE_PAYLOAD,
		webhook_url="http://example.invalid/hook",
		resend=None,
		dry_run=True,
	)
	assert delivery.get("skipped") is True


def test_apply_transitions_resend_fail_soft(monkeypatch: pytest.MonkeyPatch) -> None:
	"""Resend failure must not raise; state still advances to firing."""

	def boom_resend(**_k):
		return {"ok": False, "channel": "resend", "error": "network down"}

	monkeypatch.setattr(min_alerts, "post_resend_email", boom_resend)
	state: dict[str, Any] = {"alerts": {}}
	evals = [
		{
			"name": "health.qdrant_ask",
			"firing": True,
			"annotations": {"reasons": ["ask_ready=false"]},
			"labels": {"namespace": "unorag"},
		}
	]
	events = min_alerts.apply_transitions(
		evals,
		state,
		webhook_url="",
		resend={
			"api_key": "re_x",
			"from_addr": "a@example.com",
			"to_addrs": ["b@example.com"],
		},
		severity="warning",
		dry_run=False,
	)
	assert len(events) == 1
	assert events[0]["delivery"]["ok"] is False
	assert state["alerts"]["health.qdrant_ask"]["status"] == "firing"
