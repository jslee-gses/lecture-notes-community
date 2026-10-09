import copy
import json
from datetime import datetime, timezone
from pathlib import Path

from fastapi.testclient import TestClient

from server.app.main import Settings, create_app
from server.app.repository import MemoryRepository


FIXTURE = Path(__file__).resolve().parents[2] / "plugins" / "lecture-notes" / "tests" / "fixtures" / "valid-lecture.json"


def service(document=None):
    now = datetime(2026, 10, 9, 12, tzinfo=timezone.utc)
    repository = MemoryRepository(clock=lambda: now)
    app = create_app(Settings(public_base_url="https://notes.example", ip_hash_secret=b"test"), repository, clock=lambda: now)
    document = document or json.loads(FIXTURE.read_text(encoding="utf-8"))
    saved = repository.insert_or_get(document, "test-client")
    return TestClient(app), saved


def test_share_page():
    client, saved = service()
    response = client.get(f"/api/lectures/{saved.share_token}")
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/html")
    assert "noindex" in response.headers["x-robots-tag"]
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["referrer-policy"] == "no-referrer"
    assert "자료 구조 입문" in response.text
    assert "2027-01-07" in response.text
    assert "배열은 연속된 데이터를 저장합니다." in response.text
    assert "lecture.css" in response.text
    assert "lecture.js" in response.text

    data = client.get(f"/api/lectures/{saved.share_token}/data")
    assert data.status_code == 200
    assert data.json() == saved.document
    assert data.headers["cache-control"] == "no-store"
    assert "noindex" in data.headers["x-robots-tag"]


def test_escaped_segment():
    document = json.loads(FIXTURE.read_text(encoding="utf-8"))
    document = copy.deepcopy(document)
    document["segments"][0]["text"] = "<script>alert(1)</script>"
    client, saved = service(document)
    html = client.get(f"/api/lectures/{saved.share_token}").text
    assert "<script>alert(1)</script>" not in html
    assert "&lt;script&gt;alert(1)&lt;/script&gt;" in html


def test_no_listing():
    client, _ = service()
    assert client.get("/api/lectures").status_code == 404
    assert client.get("/").status_code == 404
