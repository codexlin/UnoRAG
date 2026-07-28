from __future__ import annotations

import hashlib
import os
from pathlib import Path

import psycopg

from app.settings import get_settings


MIGRATIONS_DIR = Path(__file__).resolve().parents[1] / "migrations"


def main() -> None:
	# Prefer explicit migrator DSN so deploy/migrate containers do not need
	# full production Settings (secrets, redis replay, active-generation gate).
	dsn = os.getenv("MIGRATOR_DATABASE_URL", "").strip()
	if not dsn:
		settings = get_settings()
		dsn = settings.worker_database_dsn
	dsn = dsn.replace("postgresql+psycopg://", "postgresql://", 1)
	if not dsn:
		raise SystemExit("MIGRATOR_DATABASE_URL is required")

	files = sorted(MIGRATIONS_DIR.glob("*.sql"))
	if not files:
		raise SystemExit(f"no migrations found in {MIGRATIONS_DIR}")

	with psycopg.connect(dsn) as connection:
		with connection.transaction():
			connection.execute(
				"SELECT pg_advisory_xact_lock(hashtext('unorag:rag:migrations'))"
			)
			connection.execute("CREATE SCHEMA IF NOT EXISTS rag")
			connection.execute(
				"""
				CREATE TABLE IF NOT EXISTS rag.schema_migrations (
					version varchar(256) PRIMARY KEY,
					checksum varchar(64) NOT NULL,
					applied_at timestamptz NOT NULL DEFAULT now()
				)
				"""
			)
			for path in files:
				sql = path.read_text(encoding="utf-8")
				checksum = hashlib.sha256(sql.encode("utf-8")).hexdigest()
				row = connection.execute(
					"""
					SELECT checksum
					FROM rag.schema_migrations
					WHERE version = %s
					""",
					(path.name,),
				).fetchone()
				if row is not None:
					if row[0] != checksum:
						raise RuntimeError(
							f"applied migration checksum changed: {path.name}"
						)
					print(f"skip {path.name}")
					continue
				connection.execute(sql)
				connection.execute(
					"""
					INSERT INTO rag.schema_migrations (version, checksum)
					VALUES (%s, %s)
					""",
					(path.name, checksum),
				)
				print(f"applied {path.name}")


if __name__ == "__main__":
	main()
