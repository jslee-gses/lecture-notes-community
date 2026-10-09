"""Unlisted, read-only lecture pages and JSON access."""

import re
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.templating import Jinja2Templates


TEMPLATES = Jinja2Templates(directory=Path(__file__).resolve().parent / "templates")
VIDEO_ID = re.compile(r"[A-Za-z0-9_-]{11}\Z")
PRIVATE_HEADERS = {
    "Cache-Control": "no-store",
    "X-Robots-Tag": "noindex, nofollow",
    "Referrer-Policy": "no-referrer",
}


def timestamp(seconds: float) -> str:
    total = max(0, int(seconds))
    hours, remainder = divmod(total, 3600)
    minutes, seconds = divmod(remainder, 60)
    return f"{hours}:{minutes:02d}:{seconds:02d}" if hours else f"{minutes:02d}:{seconds:02d}"


def viewer_router(repository) -> APIRouter:
    router = APIRouter()

    def active(share_token: str):
        saved = repository.get_active(share_token)
        if not saved:
            raise HTTPException(status_code=404, detail="Lecture not found")
        video_id = saved.document.get("lecture", {}).get("video_id")
        if not isinstance(video_id, str) or not VIDEO_ID.fullmatch(video_id):
            raise HTTPException(status_code=404, detail="Lecture not found")
        return saved

    @router.get("/api/lectures", include_in_schema=False)
    def no_listing():
        raise HTTPException(status_code=404, detail="Not found")

    @router.get("/api/lectures/{share_token}", response_class=HTMLResponse)
    def lecture_page(request: Request, share_token: str):
        saved = active(share_token)
        return TEMPLATES.TemplateResponse(
            request=request,
            name="lecture.html",
            context={
                "document": saved.document,
                "expires_at": saved.expires_at.strftime("%Y-%m-%d %H:%M UTC"),
                "timestamp": timestamp,
            },
            headers=PRIVATE_HEADERS,
        )

    @router.get("/api/lectures/{share_token}/data")
    def lecture_data(share_token: str):
        saved = active(share_token)
        return JSONResponse(saved.document, headers=PRIVATE_HEADERS)

    return router
