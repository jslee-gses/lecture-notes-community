"""Local fixture-only service for browser tests."""

import json
from datetime import datetime, timezone
from pathlib import Path

from fastapi.responses import RedirectResponse

from server.app.main import Settings, create_app
from server.app.repository import MemoryRepository


fixture = Path(__file__).resolve().parents[2] / "plugins" / "lecture-notes" / "tests" / "fixtures" / "valid-lecture.json"
now = datetime(2026, 10, 9, 12, tzinfo=timezone.utc)
repository = MemoryRepository(clock=lambda: now)
saved = repository.insert_or_get(json.loads(fixture.read_text(encoding="utf-8")), "e2e-client")
app = create_app(Settings(public_base_url="http://127.0.0.1:8765", ip_hash_secret=b"e2e"), repository, clock=lambda: now)


@app.get("/fixture")
def fixture_redirect():
    return RedirectResponse(f"/api/lectures/{saved.share_token}")
