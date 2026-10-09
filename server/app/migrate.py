"""Apply the idempotent schema migration before serving traffic."""

import os
from pathlib import Path

import psycopg


MIGRATION = Path(__file__).resolve().parents[1] / "migrations" / "001_init.sql"
MIGRATION_LOCK = 792436152844


def apply_migrations(database_url: str) -> None:
    sql = MIGRATION.read_text(encoding="utf-8")
    with psycopg.connect(database_url) as connection:
        with connection.cursor() as cursor:
            cursor.execute("SELECT pg_advisory_xact_lock(%s)", (MIGRATION_LOCK,))
            cursor.execute(sql)


if __name__ == "__main__":
    url = os.getenv("DATABASE_URL")
    if not url:
        raise SystemExit("DATABASE_URL is required")
    apply_migrations(url)
