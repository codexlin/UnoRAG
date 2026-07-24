from __future__ import annotations

import json
from pathlib import Path

from app.repositories.job_repository import JobStage, JobStatus


def test_python_job_enums_match_shared_contract():
    contract_path = (
        Path(__file__).resolve().parents[3]
        / "contracts"
        / "document-lifecycle-v1.json"
    )
    contract = json.loads(contract_path.read_text(encoding="utf-8"))

    assert {item.value for item in JobStatus} == set(contract["job_statuses"])
    assert {item.value for item in JobStage} == set(contract["job_stages"])
    assert contract["defaults"]["lease_seconds"] >= (
        contract["defaults"]["heartbeat_seconds"] * 3
    )
    assert set(contract["terminal_job_statuses"]) <= set(contract["job_statuses"])
    assert set(contract["retryable_job_statuses"]) <= set(
        contract["terminal_job_statuses"]
    )
