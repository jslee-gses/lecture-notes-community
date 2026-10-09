"""Repository contract against a real PostgreSQL instance in CI."""

import copy
import hashlib
import json
import os
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path
from uuid import uuid4

import psycopg
import pytest
from psycopg.types.json import Jsonb

from server.app.migrate import apply_migrations
from server.app.models import RunIdConflict
from server.app.rate_limit import QuotaExceeded, QuotaLimits
from server.app.repository import Repository


FIXTURE = Path(__file__).resolve().parents[2] / "plugins" / "lecture-notes" / "tests" / "fixtures" / "valid-lecture.json"
DATABASE_URL = os.getenv("TEST_DATABASE_URL")
pytestmark = pytest.mark.skipif(not DATABASE_URL, reason="TEST_DATABASE_URL is required")


def document():
    value = json.loads(FIXTURE.read_text(encoding="utf-8"))
    value["run_id"] = str(uuid4())
    return value


@pytest.fixture
def database():
    apply_migrations(DATABASE_URL)
    with psycopg.connect(DATABASE_URL) as connection:
        connection.execute("TRUNCATE lectures")
    yield DATABASE_URL
    with psycopg.connect(DATABASE_URL) as connection:
        connection.execute("TRUNCATE lectures")


def test_migration_is_repeatable(database):
    apply_migrations(database)
    with psycopg.connect(database) as connection:
        assert connection.execute("SELECT to_regclass('lectures')").fetchone()[0] == "lectures"


def test_idempotence_conflict_and_expiry(database):
    now = [datetime(2026, 10, 9, 12, tzinfo=timezone.utc)]
    repository = Repository(database, clock=lambda: now[0])
    lecture = document()
    first = repository.insert_or_get(lecture, "a" * 64)
    assert first.created
    assert first.expires_at == now[0] + timedelta(days=90)
    assert first.document == lecture
    again = repository.insert_or_get(lecture, "a" * 64)
    assert not again.created
    assert again.share_token == first.share_token
    equivalent = copy.deepcopy(lecture)
    equivalent["lecture"]["duration_sec"] = float(equivalent["lecture"]["duration_sec"])
    assert repository.insert_or_get(equivalent, "a" * 64).share_token == first.share_token
    legacy_payload = json.dumps(equivalent, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    legacy_hash = hashlib.sha256(legacy_payload.encode("utf-8")).hexdigest()
    with psycopg.connect(database) as connection:
        connection.execute("UPDATE lectures SET body_hash = %s, document = %s WHERE run_id = %s", (legacy_hash, Jsonb(equivalent), lecture["run_id"]))
    assert repository.insert_or_get(equivalent, "a" * 64).share_token == first.share_token
    assert repository.insert_or_get(lecture, "a" * 64).share_token == first.share_token
    changed = copy.deepcopy(lecture)
    changed["lecture"]["title"] = "다른 강의"
    with pytest.raises(RunIdConflict):
        repository.insert_or_get(changed, "a" * 64)
    assert repository.get_active(first.share_token) is not None
    now[0] += timedelta(days=90)
    assert repository.get_active(first.share_token) is None
    assert repository.delete_expired(now[0]) == 1
    assert repository.delete_expired(now[0]) == 0


def test_concurrent_quota_is_atomic(database):
    now = datetime(2026, 10, 9, 12, tzinfo=timezone.utc)
    repository = Repository(database, limits=QuotaLimits(per_hour=1, per_day=1, global_day=1), clock=lambda: now)
    documents = [document(), document()]

    def upload(value):
        try:
            return repository.insert_or_get(value, "a" * 64)
        except QuotaExceeded:
            return None

    with ThreadPoolExecutor(max_workers=2) as executor:
        results = list(executor.map(upload, documents))
    assert sum(result is not None for result in results) == 1
    with psycopg.connect(database) as connection:
        assert connection.execute("SELECT count(*) FROM lectures").fetchone()[0] == 1
