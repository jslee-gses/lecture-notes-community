"""Stored lecture records and repository errors."""

from dataclasses import dataclass, replace
from datetime import datetime


@dataclass(frozen=True)
class SavedLecture:
    run_id: str
    body_hash: str
    share_token: str
    client_key: str
    created_at: datetime
    expires_at: datetime
    document: dict
    is_listed: bool = False
    created: bool = True

    def as_existing(self) -> "SavedLecture":
        return replace(self, created=False)


@dataclass(frozen=True)
class PublicLecture:
    share_token: str
    title: str
    duration_sec: int
    created_at: datetime


class RunIdConflict(Exception):
    pass


class UploadsDisabled(Exception):
    pass
