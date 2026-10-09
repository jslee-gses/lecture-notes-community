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
saved = repository.insert_or_get(json.loads(fixture.read_text(encoding="utf-8")), "e2e-client", is_listed=True)
long_document = json.loads(fixture.read_text(encoding="utf-8"))
long_document["run_id"] = "fbb764d7-740f-4d21-9ae3-2635bfbb474b"
long_document["segments"] = [
    {**long_document["segments"][0], "start_sec": number * 8,
     "end_sec": number * 8 + 7,
     "text": f"긴 전사 {number} C++ [배열] <script>window.__injected=true</script>" if number == 2 else f"긴 전사 {number} 배열 설명"}
    for number in range(120)
]
long_document["summary_note"]["key_points"] = [
    {**long_document["summary_note"]["key_points"][0], "text": f"긴 강의의 핵심 내용 {number}"}
    for number in range(60)
]
long_saved = repository.insert_or_get(long_document, "e2e-client")
english_fixture = Path(__file__).resolve().parents[2] / "plugins" / "lecture-notes" / "tests" / "fixtures" / "valid-english-lecture.json"
english_document = json.loads(english_fixture.read_text(encoding="utf-8"))
english_document["segments"][0]["text"] += " <script>window.__injected=true</script>"
english_saved = repository.insert_or_get(english_document, "e2e-client")
app = create_app(Settings(public_base_url="http://127.0.0.1:8765", ip_hash_secret=b"e2e"), repository, clock=lambda: now)


@app.get("/fixture")
def fixture_redirect():
    return RedirectResponse(f"/api/lectures/{saved.share_token}")


@app.get("/fixture-long")
def long_fixture_redirect():
    return RedirectResponse(f"/api/lectures/{long_saved.share_token}")


@app.get("/fixture-en")
def english_fixture_redirect():
    return RedirectResponse(f"/api/lectures/{english_saved.share_token}")
