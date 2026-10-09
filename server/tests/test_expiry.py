import json
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path

from fastapi.testclient import TestClient

from server.app.main import Settings, create_app
from server.app.repository import MemoryRepository


FIXTURE = Path(__file__).resolve().parents[2] / "plugins" / "lecture-notes" / "tests" / "fixtures" / "valid-lecture.json"


def test_unknown_or_expired():
    now = [datetime(2026, 10, 9, 12, tzinfo=timezone.utc)]
    repository = MemoryRepository(clock=lambda: now[0])
    app = create_app(Settings(public_base_url="https://notes.example", ip_hash_secret=b"test"), repository, clock=lambda: now[0])
    client = TestClient(app)
    document = json.loads(FIXTURE.read_text(encoding="utf-8"))
    saved = repository.insert_or_get(document, "test-client")
    assert client.get("/api/lectures/unknown").status_code == 404
    assert client.get("/api/lectures/unknown/data").status_code == 404
    now[0] = saved.expires_at
    assert client.get(f"/api/lectures/{saved.share_token}").status_code == 404
    assert client.get(f"/api/lectures/{saved.share_token}/data").status_code == 404
    assert repository.delete_expired(now[0]) == 1
    assert repository.saved_count == 0


def test_periodic_cleanup_on_startup():
    now = [datetime(2026, 10, 9, 12, tzinfo=timezone.utc)]
    cleaned = threading.Event()

    class ObservedRepository(MemoryRepository):
        def delete_expired(self, current):
            count = super().delete_expired(current)
            cleaned.set()
            return count

    repository = ObservedRepository(clock=lambda: now[0])
    document = json.loads(FIXTURE.read_text(encoding="utf-8"))
    repository.insert_or_get(document, "test-client")
    now[0] += timedelta(days=91)
    app = create_app(Settings(public_base_url="https://notes.example", ip_hash_secret=b"test", cleanup_interval_seconds=60), repository, clock=lambda: now[0])
    with TestClient(app):
        assert cleaned.wait(timeout=3), "periodic cleanup did not start"
    assert repository.saved_count == 0


def test_periodic_cleanup_after_expiry():
    now = [datetime(2026, 10, 9, 12, tzinfo=timezone.utc)]
    swept = threading.Event()

    class ObservedRepository(MemoryRepository):
        def delete_expired(self, current):
            count = super().delete_expired(current)
            swept.set()
            return count

    repository = ObservedRepository(clock=lambda: now[0])
    document = json.loads(FIXTURE.read_text(encoding="utf-8"))
    repository.insert_or_get(document, "test-client")
    app = create_app(Settings(public_base_url="https://notes.example", ip_hash_secret=b"test", cleanup_interval_seconds=1), repository, clock=lambda: now[0])
    with TestClient(app):
        assert swept.wait(timeout=3), "initial cleanup did not run"
        assert repository.saved_count == 1
        swept.clear()
        now[0] += timedelta(days=91)
        assert swept.wait(timeout=3), "periodic cleanup did not repeat"
        assert repository.saved_count == 0
