"""Anonymous upload endpoint for lecture notes."""

import json
import os
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Callable

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from .contract import validate_document
from .models import RunIdConflict, UploadsDisabled
from .rate_limit import QuotaExceeded, QuotaLimits, client_key, resolve_client_ip
from .repository import Repository


@dataclass(frozen=True)
class Settings:
    public_base_url: str = ""
    ip_hash_secret: bytes = b""
    database_url: str | None = None
    trusted_proxy_cidrs: tuple[str, ...] = ()
    max_body_bytes: int = 10 * 1024 * 1024
    limits: QuotaLimits = QuotaLimits()
    uploads_enabled: bool = True

    @classmethod
    def from_env(cls) -> "Settings":
        return cls(
            public_base_url=os.getenv("PUBLIC_BASE_URL", ""),
            ip_hash_secret=os.getenv("IP_HASH_SECRET", "").encode("utf-8"),
            database_url=os.getenv("DATABASE_URL"),
            trusted_proxy_cidrs=tuple(filter(None, (part.strip() for part in os.getenv("TRUSTED_PROXY_CIDRS", "").split(",")))),
            max_body_bytes=int(os.getenv("MAX_UPLOAD_BYTES", str(10 * 1024 * 1024))),
            limits=QuotaLimits(
                per_hour=int(os.getenv("UPLOADS_PER_HOUR_IP", "3")),
                per_day=int(os.getenv("UPLOADS_PER_DAY_IP", "10")),
                global_day=int(os.getenv("UPLOADS_PER_DAY_GLOBAL", "200")),
            ),
            uploads_enabled=os.getenv("UPLOADS_ENABLED", "true").lower() in ("true", "1", "yes"),
        )


def create_app(settings: Settings | None = None, repository=None, clock: Callable[[], datetime] | None = None) -> FastAPI:
    settings = settings or Settings.from_env()
    clock = clock or (lambda: datetime.now(timezone.utc))
    repository = repository or Repository(settings.database_url, settings.limits, settings.uploads_enabled, clock)
    app = FastAPI(title="Lecture Notes")

    @app.post("/api/lectures")
    async def upload_lecture(request: Request):
        if not settings.public_base_url.startswith("https://") or not settings.ip_hash_secret or not settings.database_url and isinstance(repository, Repository):
            return JSONResponse(status_code=503, content={"detail": "server is not configured"})

        content_length = request.headers.get("content-length")
        if content_length and content_length.isdecimal() and int(content_length) > settings.max_body_bytes:
            return JSONResponse(status_code=413, content={"detail": "JSON upload exceeds size limit"})
        payload = bytearray()
        async for chunk in request.stream():
            if len(payload) + len(chunk) > settings.max_body_bytes:
                return JSONResponse(status_code=413, content={"detail": "JSON upload exceeds size limit"})
            payload.extend(chunk)
        try:
            document = json.loads(payload)
            validate_document(document)
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as error:
            return JSONResponse(status_code=422, content={"detail": str(error)})

        peer = request.client.host if request.client else "0.0.0.0"
        ip = resolve_client_ip(peer, request.headers.get("x-real-ip"), settings.trusted_proxy_cidrs)
        now = clock()
        current_key = client_key(ip, settings.ip_hash_secret, now.date())
        previous_key = client_key(ip, settings.ip_hash_secret, (now - timedelta(days=1)).date())
        try:
            saved = repository.insert_or_get(document, current_key, previous_key)
        except RunIdConflict as error:
            return JSONResponse(status_code=409, content={"detail": str(error)})
        except QuotaExceeded as error:
            return JSONResponse(status_code=429, content={"detail": str(error)}, headers={"Retry-After": str(error.retry_after)})
        except UploadsDisabled as error:
            return JSONResponse(status_code=503, content={"detail": str(error)})
        return JSONResponse(
            status_code=201 if saved.created else 200,
            content={
                "share_url": f"{settings.public_base_url.rstrip('/')}/api/lectures/{saved.share_token}",
                "expires_at": saved.expires_at.isoformat(),
            },
        )

    return app


app = create_app()
