"""Regression: Postgres rejects ambiguous text vs varchar comparisons in CASE.

psycopg passes str params as `text`. Comparing them to `varchar` columns /
literals without an explicit cast raises:
  operator does not exist: character varying = text
inside UPDATE ... CASE WHEN %(status)s = 'retry' ...
"""

from __future__ import annotations

from pathlib import Path

REPO_SQL = (
	Path(__file__).resolve().parents[1] / "app" / "repositories" / "job_repository.py"
).read_text(encoding="utf-8")


def test_reap_expired_status_updates_cast_params_to_varchar() -> None:
	# reap_expired + complete/fail paths that SET status from a bound param
	assert REPO_SQL.count("%(status)s::varchar(32)") >= 9
	# No bare CASE comparisons that reintroduce the ambiguity
	assert "WHEN %(status)s = 'retry'" not in REPO_SQL
	assert "WHEN %(status)s IN (" not in REPO_SQL
