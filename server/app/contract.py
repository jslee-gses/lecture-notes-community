"""Shared lecture JSON contract and cross-reference checks."""

import json
import math
from pathlib import Path

from jsonschema import Draft202012Validator


SCHEMA_DIR = Path(__file__).resolve().parents[2] / "plugins" / "lecture-notes" / "schema"
VALIDATORS = {}
for version, filename in (("1.0", "lecture.schema.json"), ("2.0", "lecture-v2.schema.json")):
    schema = json.loads((SCHEMA_DIR / filename).read_text(encoding="utf-8"))
    Draft202012Validator.check_schema(schema)
    VALIDATORS[version] = Draft202012Validator(schema)


def _fail(path: str, detail: str) -> None:
    raise ValueError(f"{path}: {detail}")


def _check_finite(value, path: str = "") -> None:
    if isinstance(value, float) and not math.isfinite(value):
        _fail(path or "/", "number must be finite")
    if isinstance(value, dict):
        for key, child in value.items():
            _check_finite(child, f"{path}/{key}")
    elif isinstance(value, list):
        for index, child in enumerate(value):
            _check_finite(child, f"{path}/{index}")


def _check_range(item: dict, path: str, segments: list[dict]) -> None:
    start_idx = int(item["start_idx"])
    end_idx = int(item["end_idx"])
    if start_idx > end_idx or end_idx > len(segments):
        _fail(f"{path}/end_idx", "invalid segment range")
    if item["start_sec"] != segments[start_idx - 1]["start_sec"]:
        _fail(f"{path}/start_sec", "must match first segment start")
    if item["end_sec"] != segments[end_idx - 1]["end_sec"]:
        _fail(f"{path}/end_sec", "must match last segment end")


def validate_document(doc: dict) -> None:
    """Raise a JSON-pointer-like ValueError for invalid shared documents."""
    _check_finite(doc)
    version = doc.get("schema_version") if isinstance(doc, dict) else None
    if version not in VALIDATORS:
        _fail("/schema_version", "unsupported version")
    errors = sorted(VALIDATORS[version].iter_errors(doc), key=lambda error: (list(map(str, error.path)), error.message))
    if errors:
        error = errors[0]
        path = "".join(f"/{part}" for part in error.path)
        if error.validator == "required":
            missing = next((key for key in error.validator_value if key not in error.instance), None)
            if missing:
                path += f"/{missing}"
        _fail(path or "/", error.message)

    segments = doc["segments"]
    lecture = doc["lecture"]
    if lecture["url"] != f"https://www.youtube.com/watch?v={lecture['video_id']}":
        _fail("/lecture/url", "video ID does not match canonical URL")
    previous_end = 0
    for number, segment in enumerate(segments):
        path = f"/segments/{number}"
        if segment["idx"] != number + 1:
            _fail(f"{path}/idx", "indices must be contiguous and 1-based")
        if segment["start_sec"] < previous_end:
            _fail(f"{path}/start_sec", "times must be monotonic")
        if segment["end_sec"] <= segment["start_sec"] or segment["end_sec"] > lecture["duration_sec"]:
            _fail(f"{path}/end_sec", "end must follow start and fit video duration")
        previous_end = segment["end_sec"]

    next_chapter_idx = 1
    for chapter_number, chapter in enumerate(doc["outline"]["chapters"]):
        path = f"/outline/chapters/{chapter_number}"
        if chapter["start_idx"] != next_chapter_idx:
            _fail(f"{path}/start_idx", "chapter gap or overlap")
        _check_range(chapter, path, segments)
        next_child_idx = chapter["start_idx"]
        for child_number, child in enumerate(chapter["children"]):
            child_path = f"{path}/children/{child_number}"
            if child["start_idx"] != next_child_idx:
                _fail(f"{child_path}/start_idx", "child gap or overlap")
            if child["end_idx"] > chapter["end_idx"]:
                _fail(f"{child_path}/end_idx", "child exceeds chapter")
            _check_range(child, child_path, segments)
            next_child_idx = child["end_idx"] + 1
        if next_child_idx != chapter["end_idx"] + 1:
            _fail(f"{path}/children", "children do not cover chapter")
        next_chapter_idx = chapter["end_idx"] + 1
    if next_chapter_idx != len(segments) + 1:
        _fail("/outline/chapters", "chapters do not cover all segments")

    for point_number, point in enumerate(doc["summary_note"]["key_points"]):
        path = f"/summary_note/key_points/{point_number}"
        previous_idx = 0
        for ref_number, idx in enumerate(point["segment_idxs"]):
            if idx <= previous_idx or idx > len(segments):
                _fail(f"{path}/segment_idxs/{ref_number}", "invalid or unordered reference")
            previous_idx = idx
        if point["start_sec"] != segments[int(point["segment_idxs"][0]) - 1]["start_sec"]:
            _fail(f"{path}/start_sec", "must match first referenced segment")
    for term_number, term in enumerate(doc["glossary"]):
        path = f"/glossary/{term_number}"
        if term["first_segment_idx"] > len(segments):
            _fail(f"{path}/first_segment_idx", "missing segment")
        if term["start_sec"] != segments[int(term["first_segment_idx"]) - 1]["start_sec"]:
            _fail(f"{path}/start_sec", "must match referenced segment")
