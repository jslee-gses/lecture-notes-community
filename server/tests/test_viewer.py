import copy
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

from fastapi.testclient import TestClient

from server.app.main import Settings, create_app
from server.app.repository import MemoryRepository
from server.app.rate_limit import QuotaLimits


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
    assert 'href="/static/lecture.css"' in response.text
    assert 'src="/static/lecture.js"' in response.text
    for phrase in ["링크를 아는 사람과 공유", "KOREAN LECTURE · AUTO CAPTIONS", "강의의 흐름, 핵심 내용, 용어를 원본 영상의 시점과 함께 살펴보세요.", "LECTURE / NOTES"]:
        assert phrase not in response.text
    assert 'role="tablist"' in response.text
    assert 'href="/"' in response.text

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


def catalog_service():
    now = [datetime(2026, 10, 9, 12, tzinfo=timezone.utc)]
    repository = MemoryRepository(limits=QuotaLimits(100, 100, 100), clock=lambda: now[0])
    app = create_app(Settings(public_base_url="https://notes.example", ip_hash_secret=b"test"), repository, clock=lambda: now[0])
    return TestClient(app), repository, now


def catalog_document(title="자료 구조 입문"):
    from uuid import uuid4
    document = json.loads(FIXTURE.read_text(encoding="utf-8"))
    document["run_id"] = str(uuid4())
    document["lecture"]["title"] = title
    return document


def test_catalog_empty_and_new_public_entry():
    client, repository, _ = catalog_service()
    empty = client.get("/")
    assert empty.status_code == 200
    assert "등록된 강의가 없습니다" in empty.text
    public = repository.insert_or_get(catalog_document("공개 강의"), "test-client", is_listed=True)
    response = client.get("/")
    assert response.status_code == 200
    assert "공개 강의" in response.text
    assert f'href="/api/lectures/{public.share_token}"' in response.text
    assert client.get(f"/api/lectures/{public.share_token}").status_code == 200
    assert client.get("/api/lectures").status_code == 404


def test_catalog_pagination():
    client, repository, now = catalog_service()
    for number in range(21):
        now[0] += timedelta(seconds=1)
        repository.insert_or_get(catalog_document(f"강의 {number}"), "test-client", is_listed=True)
    first = client.get("/")
    assert first.status_code == 200
    assert "강의 20" in first.text
    assert "강의 0" not in first.text
    assert 'href="/?page=2"' in first.text
    second = client.get("/?page=2")
    assert "강의 0" in second.text
    assert "강의 20" not in second.text
    assert 'href="/?page=1"' in second.text
    for page in ["0", "-1", "1001", "abc"]:
        assert client.get(f"/?page={page}").status_code == 422


def test_catalog_expiry_and_escaping():
    client, repository, now = catalog_service()
    repository.insert_or_get(catalog_document("비공개 강의"), "test-client")
    listed = repository.insert_or_get(catalog_document("<script>alert(1)</script>"), "test-client", is_listed=True)
    expired = repository.insert_or_get(catalog_document("만료 강의"), "test-client", is_listed=True)
    from dataclasses import replace
    repository._by_run_id[expired.run_id] = replace(expired, expires_at=now[0])
    response = client.get("/")
    assert listed.share_token in response.text
    assert "비공개 강의" not in response.text
    assert "만료 강의" not in response.text
    assert "<script>alert(1)</script>" not in response.text
    assert "&lt;script&gt;alert(1)&lt;/script&gt;" in response.text
