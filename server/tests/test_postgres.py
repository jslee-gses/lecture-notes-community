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


def test_public_listing_migration_preserves_old_rows(database):
    old = document()
    with psycopg.connect(database) as connection:
        connection.execute("ALTER TABLE lectures DROP COLUMN is_listed")
        connection.execute(
            "INSERT INTO lectures (run_id, body_hash, share_token, client_key, created_at, expires_at, document) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s)",
            (old["run_id"], "a" * 64, "old-token", "b" * 64,
             datetime(2026, 10, 9, tzinfo=timezone.utc), datetime(2027, 1, 7, tzinfo=timezone.utc), Jsonb(old)),
        )
    apply_migrations(database)
    apply_migrations(database)
    with psycopg.connect(database) as connection:
        assert connection.execute("SELECT is_listed FROM lectures WHERE run_id = %s", (old["run_id"],)).fetchone()[0] is False


def test_public_query_order_and_page_size(database):
    now = [datetime(2026, 10, 9, 12, tzinfo=timezone.utc)]
    repository = Repository(database, limits=QuotaLimits(per_hour=100, per_day=100, global_day=100), clock=lambda: now[0])
    expected = []
    for number in range(21):
        now[0] += timedelta(seconds=1)
        entry = document()
        entry["lecture"]["title"] = f"Public {number}"
        expected.append(repository.insert_or_get(entry, "a" * 64, is_listed=True))
    repository.insert_or_get(document(), "a" * 64)
    now[0] += timedelta(seconds=1)
    expired = repository.insert_or_get(document(), "a" * 64, is_listed=True)
    with psycopg.connect(database) as connection:
        connection.execute("UPDATE lectures SET expires_at = %s WHERE run_id = %s", (now[0], expired.run_id))
    first, has_next = repository.list_public(1)
    second, last_has_next = repository.list_public(2)
    assert [item.share_token for item in first] == [item.share_token for item in reversed(expected[1:])]
    assert [item.share_token for item in second] == [expected[0].share_token]
    assert first[0].title == "Public 20"
    assert first[0].duration_sec == expected[-1].document["lecture"]["duration_sec"]
    assert has_next is True
    assert last_has_next is False


def test_public_visibility_is_immutable_on_retry(database):
    repository = Repository(database, limits=QuotaLimits(per_hour=2, per_day=2, global_day=2))
    private = document()
    public = document()
    first_private = repository.insert_or_get(private, "a" * 64)
    first_public = repository.insert_or_get(public, "a" * 64, is_listed=True)
    assert repository.insert_or_get(private, "a" * 64, is_listed=True).is_listed is False
    assert repository.insert_or_get(public, "a" * 64).is_listed is True
    assert repository.list_public(1)[0][0].share_token == first_public.share_token
    with psycopg.connect(database) as connection:
        assert connection.execute("SELECT count(*) FROM lectures").fetchone()[0] == 2
        assert connection.execute("SELECT is_listed FROM lectures WHERE run_id = %s", (first_private.run_id,)).fetchone()[0] is False


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
