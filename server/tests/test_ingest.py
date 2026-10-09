import copy
import hashlib
import json
from dataclasses import replace
from datetime import datetime, timedelta, timezone
from pathlib import Path
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from server.app.main import Settings, create_app
from server.app.rate_limit import QuotaLimits
from server.app.repository import MemoryRepository


FIXTURE = Path(__file__).resolve().parents[2] / "plugins" / "lecture-notes" / "tests" / "fixtures" / "valid-lecture.json"


def document():
    value = json.loads(FIXTURE.read_text(encoding="utf-8"))
    value["run_id"] = str(uuid4())
    return value


@pytest.fixture
def service():
    now = [datetime(2026, 10, 9, 12, tzinfo=timezone.utc)]

    def make(limits=None, uploads_enabled=True, trusted_proxy_cidrs=(), peer="203.0.113.8"):
        policy = limits or QuotaLimits()
        settings = Settings(
            public_base_url="https://notes.example",
            ip_hash_secret=b"unit-test-secret",
            trusted_proxy_cidrs=trusted_proxy_cidrs,
            max_body_bytes=10 * 1024 * 1024,
            limits=policy,
            uploads_enabled=uploads_enabled,
        )
        repository = MemoryRepository(limits=policy, clock=lambda: now[0], uploads_enabled=uploads_enabled)
        client = TestClient(create_app(settings=settings, repository=repository, clock=lambda: now[0]), client=(peer, 5000))
        return client, repository, now

    return make


def upload(client, doc=None, **kwargs):
    return client.post("/api/lectures", json=doc or document(), **kwargs)


def test_valid_upload(service):
    client, repository, _ = service()
    response = upload(client)
    assert response.status_code == 201
    assert response.json()["share_url"].startswith("https://notes.example/api/lectures/")
    assert response.json()["expires_at"].startswith("2027-01-07")
    assert repository.saved_count == 1


def test_too_large(service):
    client, repository, _ = service()
    response = client.post("/api/lectures", content=b"x" * (10 * 1024 * 1024 + 1))
    assert response.status_code == 413
    assert repository.saved_count == 0


def test_unsupported_schema(service):
    client, repository, _ = service()
    doc = document()
    doc["schema_version"] = "2.0"
    response = upload(client, doc)
    assert response.status_code == 422
    assert "/schema_version" in response.json()["detail"]
    assert repository.saved_count == 0


def test_idempotent_retry(service):
    client, repository, _ = service()
    doc = document()
    first = upload(client, doc)
    assert upload(client).status_code == 201
    assert upload(client).status_code == 201
    reordered = dict(reversed(list(doc.items())))
    second = upload(client, reordered)
    assert first.status_code == 201
    assert second.status_code == 200
    assert first.json()["share_url"] == second.json()["share_url"]
    assert repository.saved_count == 3
    assert repository.quota_count == 3


def test_integral_float_references_are_valid(service):
    client, repository, _ = service()
    doc = document()
    chapter = doc["outline"]["chapters"][0]
    chapter["start_idx"] = float(chapter["start_idx"])
    chapter["end_idx"] = float(chapter["end_idx"])
    chapter["children"][0]["start_idx"] = float(chapter["children"][0]["start_idx"])
    chapter["children"][0]["end_idx"] = float(chapter["children"][0]["end_idx"])
    point = doc["summary_note"]["key_points"][0]
    point["segment_idxs"][0] = float(point["segment_idxs"][0])
    doc["glossary"][0]["first_segment_idx"] = float(doc["glossary"][0]["first_segment_idx"])
    response = upload(client, doc)
    assert response.status_code == 201
    assert repository.saved_count == 1


def test_numeric_equivalent_retry_does_not_use_quota(service):
    client, repository, _ = service(QuotaLimits(per_hour=1, per_day=1, global_day=1))
    doc = document()
    first = upload(client, doc)
    equivalent = copy.deepcopy(doc)
    equivalent["lecture"]["duration_sec"] = float(equivalent["lecture"]["duration_sec"])
    second = upload(client, equivalent)
    assert first.status_code == 201
    assert second.status_code == 200
    assert first.json()["share_url"] == second.json()["share_url"]
    assert repository.saved_count == 1


def test_retry_of_preexisting_float_document(service):
    client, repository, _ = service(QuotaLimits(per_hour=1, per_day=1, global_day=1))
    doc = document()
    doc["lecture"]["duration_sec"] = float(doc["lecture"]["duration_sec"])
    first = upload(client, doc)
    assert first.status_code == 201
    legacy_payload = json.dumps(doc, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    legacy_hash = hashlib.sha256(legacy_payload.encode("utf-8")).hexdigest()
    repository._by_run_id[doc["run_id"]] = replace(repository._by_run_id[doc["run_id"]], body_hash=legacy_hash)
    retry = upload(client, doc)
    assert retry.status_code == 200
    assert retry.json()["share_url"] == first.json()["share_url"]
    equivalent = copy.deepcopy(doc)
    equivalent["lecture"]["duration_sec"] = int(equivalent["lecture"]["duration_sec"])
    assert upload(client, equivalent).status_code == 200
    assert repository.saved_count == 1


@pytest.mark.parametrize("value", ["NaN", "Infinity", "-Infinity", "1e400"])
def test_nonfinite_json_number_is_rejected(service, value):
    client, repository, _ = service()
    doc = document()
    payload = json.dumps(doc)
    duration = f'"duration_sec": {doc["lecture"]["duration_sec"]}'
    assert duration in payload
    payload = payload.replace(duration, f'"duration_sec": {value}', 1)
    response = client.post("/api/lectures", content=payload, headers={"Content-Type": "application/json"})
    assert response.status_code == 422
    assert repository.saved_count == 0


def test_run_id_conflict(service):
    client, repository, _ = service()
    doc = document()
    assert upload(client, doc).status_code == 201
    changed = copy.deepcopy(doc)
    changed["lecture"]["title"] = "다른 강의"
    assert upload(client, changed).status_code == 409
    assert repository.saved_count == 1


def test_hour_limit(service):
    client, repository, _ = service()
    for _ in range(3):
        assert upload(client).status_code == 201
    response = upload(client)
    assert response.status_code == 429
    assert response.headers["retry-after"]
    assert repository.saved_count == 3


def test_day_limit(service):
    client, repository, _ = service(QuotaLimits(per_hour=20, per_day=10, global_day=200))
    for _ in range(10):
        assert upload(client).status_code == 201
    assert upload(client).status_code == 429
    assert repository.saved_count == 10


def test_global_limit(service):
    client, repository, _ = service(QuotaLimits(per_hour=300, per_day=300, global_day=200))
    for _ in range(200):
        assert upload(client).status_code == 201
    assert upload(client).status_code == 429
    assert repository.saved_count == 200


def test_spoofed_forwarded_for(service):
    client, repository, _ = service()
    for number in range(3):
        headers = {"X-Real-IP": f"198.51.100.{number + 1}", "X-Forwarded-For": f"192.0.2.{number + 1}"}
        assert upload(client, headers=headers).status_code == 201
    assert upload(client, headers={"X-Real-IP": "198.51.100.99"}).status_code == 429
    assert repository.saved_count == 3


def test_trusted_proxy_real_ip(service):
    client, _, _ = service(trusted_proxy_cidrs=("10.0.0.0/8",), peer="10.1.2.3")
    for _ in range(3):
        assert upload(client, headers={"X-Real-IP": "198.51.100.1"}).status_code == 201
    assert upload(client, headers={"X-Real-IP": "198.51.100.2"}).status_code == 201


def test_hour_limit_across_midnight(service):
    client, _, now = service()
    now[0] = datetime(2026, 10, 9, 23, 59, tzinfo=timezone.utc)
    for _ in range(3):
        assert upload(client).status_code == 201
    now[0] += timedelta(minutes=2)
    assert upload(client).status_code == 429


def test_uploads_disabled_allows_existing_retry(service):
    client, repository, _ = service(uploads_enabled=False)
    assert upload(client).status_code == 503
    assert repository.saved_count == 0
