"""Atomic lecture persistence and a local in-memory test repository."""

import hashlib
import json
import secrets
import threading
from datetime import datetime, time, timedelta, timezone
from typing import Callable

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from .models import PublicLecture, RunIdConflict, SavedLecture, UploadsDisabled
from .rate_limit import QuotaLimits, enforce_limits


RETENTION_DAYS = 90
UPLOAD_ADVISORY_LOCK = 792436152843


def canonical_hash(doc: dict) -> str:
    def normalize(value):
        if isinstance(value, dict):
            return {key: normalize(child) for key, child in value.items()}
        if isinstance(value, list):
            return [normalize(child) for child in value]
        if isinstance(value, float) and value.is_integer():
            return int(value)
        return value

    payload = json.dumps(normalize(doc), sort_keys=True, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _day_start(now: datetime) -> datetime:
    return datetime.combine(now.date(), time.min, tzinfo=timezone.utc)


class Repository:
    """PostgreSQL repository; quota check and insert share one transaction."""

    def __init__(
        self,
        database_url: str | None,
        limits: QuotaLimits = QuotaLimits(),
        uploads_enabled: bool = True,
        clock: Callable[[], datetime] = lambda: datetime.now(timezone.utc),
    ):
        self.database_url = database_url
        self.limits = limits
        self.uploads_enabled = uploads_enabled
        self.clock = clock

    def _connect(self):
        if not self.database_url:
            raise RuntimeError("DATABASE_URL is not configured")
        return psycopg.connect(self.database_url, row_factory=dict_row)

    def insert_or_get(self, doc: dict, client_key: str, previous_client_key: str | None = None, *, is_listed: bool = False) -> SavedLecture:
        body_hash = canonical_hash(doc)
        now = self.clock()
        previous_client_key = previous_client_key or client_key
        with self._connect() as connection:
            with connection.cursor() as cursor:
                # One lock serializes the low-volume anonymous quota and run-ID decision.
                cursor.execute("SELECT pg_advisory_xact_lock(%s)", (UPLOAD_ADVISORY_LOCK,))
                cursor.execute("SELECT * FROM lectures WHERE run_id = %s", (doc["run_id"],))
                existing = cursor.fetchone()
                if existing:
                    if existing["body_hash"] != body_hash and canonical_hash(existing["document"]) != body_hash:
                        raise RunIdConflict("run_id already belongs to different content")
                    return self._saved(existing).as_existing()
                if not self.uploads_enabled:
                    raise UploadsDisabled("new uploads are disabled")
                day_start = _day_start(now)
                hour_start = now - timedelta(hours=1)
                cursor.execute(
                    """
                    SELECT
                      COUNT(*) FILTER (WHERE created_at >= %s AND client_key IN (%s, %s)) AS hourly,
                      COUNT(*) FILTER (WHERE created_at >= %s AND client_key = %s) AS daily,
                      COUNT(*) FILTER (WHERE created_at >= %s) AS global_daily
                    FROM lectures
                    WHERE created_at >= %s
                    """,
                    (hour_start, client_key, previous_client_key, day_start, client_key, day_start, min(hour_start, day_start)),
                )
                counts = cursor.fetchone()
                enforce_limits(counts["hourly"], counts["daily"], counts["global_daily"], self.limits)
                share_token = secrets.token_urlsafe(24)
                expires_at = now + timedelta(days=RETENTION_DAYS)
                cursor.execute(
                    """
                    INSERT INTO lectures (run_id, body_hash, share_token, client_key, created_at, expires_at, document, is_listed)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                    RETURNING *
                    """,
                    (doc["run_id"], body_hash, share_token, client_key, now, expires_at, Jsonb(doc), is_listed),
                )
                return self._saved(cursor.fetchone())

    def get_active(self, share_token: str) -> SavedLecture | None:
        with self._connect() as connection:
            with connection.cursor() as cursor:
                cursor.execute("SELECT * FROM lectures WHERE share_token = %s AND expires_at > %s", (share_token, self.clock()))
                row = cursor.fetchone()
                return self._saved(row) if row else None

    def list_public(self, page: int, page_size: int = 20) -> tuple[list[PublicLecture], bool]:
        if page < 1 or page_size < 1:
            raise ValueError("page and page_size must be positive")
        with self._connect() as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    """SELECT share_token, document #>> '{lecture,title}' AS title,
                              (document #>> '{lecture,duration_sec}')::numeric::integer AS duration_sec, created_at
                       FROM lectures
                       WHERE is_listed AND expires_at > %s
                       ORDER BY created_at DESC, run_id DESC
                       LIMIT %s OFFSET %s""",
                    (self.clock(), page_size + 1, (page - 1) * page_size),
                )
                rows = cursor.fetchall()
        return [PublicLecture(**row) for row in rows[:page_size]], len(rows) > page_size

    def delete_expired(self, now: datetime) -> int:
        with self._connect() as connection:
            with connection.cursor() as cursor:
                cursor.execute("DELETE FROM lectures WHERE expires_at <= %s", (now,))
                return cursor.rowcount

    @staticmethod
    def _saved(row: dict) -> SavedLecture:
        return SavedLecture(
            run_id=str(row["run_id"]),
            body_hash=row["body_hash"],
            share_token=row["share_token"],
            client_key=row["client_key"],
            created_at=row["created_at"],
            expires_at=row["expires_at"],
            document=row["document"],
            is_listed=row["is_listed"],
        )


class MemoryRepository:
    """Transaction-shaped local implementation used by API tests."""

    def __init__(
        self,
        limits: QuotaLimits = QuotaLimits(),
        uploads_enabled: bool = True,
        clock: Callable[[], datetime] = lambda: datetime.now(timezone.utc),
    ):
        self.limits = limits
        self.uploads_enabled = uploads_enabled
        self.clock = clock
        self._lock = threading.RLock()
        self._by_run_id: dict[str, SavedLecture] = {}
        self._by_token: dict[str, SavedLecture] = {}

    @property
    def saved_count(self) -> int:
        return len(self._by_run_id)

    @property
    def quota_count(self) -> int:
        return len(self._by_run_id)

    def insert_or_get(self, doc: dict, client_key: str, previous_client_key: str | None = None, *, is_listed: bool = False) -> SavedLecture:
        body_hash = canonical_hash(doc)
        now = self.clock()
        previous_client_key = previous_client_key or client_key
        with self._lock:
            existing = self._by_run_id.get(doc["run_id"])
            if existing:
                if existing.body_hash != body_hash and canonical_hash(existing.document) != body_hash:
                    raise RunIdConflict("run_id already belongs to different content")
                return existing.as_existing()
            if not self.uploads_enabled:
                raise UploadsDisabled("new uploads are disabled")
            rows = list(self._by_run_id.values())
            hour_count = sum(
                row.client_key in (client_key, previous_client_key) and row.created_at >= now - timedelta(hours=1)
                for row in rows
            )
            day_count = sum(row.client_key == client_key and row.created_at >= _day_start(now) for row in rows)
            global_count = sum(row.created_at >= _day_start(now) for row in rows)
            enforce_limits(hour_count, day_count, global_count, self.limits)
            saved = SavedLecture(
                run_id=doc["run_id"],
                body_hash=body_hash,
                share_token=secrets.token_urlsafe(24),
                client_key=client_key,
                created_at=now,
                expires_at=now + timedelta(days=RETENTION_DAYS),
                document=doc,
                is_listed=is_listed,
            )
            self._by_run_id[saved.run_id] = saved
            self._by_token[saved.share_token] = saved
            return saved

    def get_active(self, share_token: str) -> SavedLecture | None:
        saved = self._by_token.get(share_token)
        return saved if saved and saved.expires_at > self.clock() else None

    def list_public(self, page: int, page_size: int = 20) -> tuple[list[PublicLecture], bool]:
        if page < 1 or page_size < 1:
            raise ValueError("page and page_size must be positive")
        with self._lock:
            rows = sorted(
                (row for row in self._by_run_id.values() if row.is_listed and row.expires_at > self.clock()),
                key=lambda row: (row.created_at, row.run_id),
                reverse=True,
            )
            offset = (page - 1) * page_size
            selected = rows[offset:offset + page_size + 1]
            return [
                PublicLecture(row.share_token, row.document["lecture"]["title"],
                              int(row.document["lecture"]["duration_sec"]), row.created_at)
                for row in selected[:page_size]
            ], len(selected) > page_size

    def delete_expired(self, now: datetime) -> int:
        with self._lock:
            expired = [saved for saved in self._by_run_id.values() if saved.expires_at <= now]
            for saved in expired:
                self._by_run_id.pop(saved.run_id)
                self._by_token.pop(saved.share_token)
            return len(expired)
