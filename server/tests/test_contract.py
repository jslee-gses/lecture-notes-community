import copy
import json
from pathlib import Path

import pytest

from server.app.contract import validate_document


FIXTURE = Path(__file__).resolve().parents[2] / "plugins" / "lecture-notes" / "tests" / "fixtures" / "valid-lecture.json"
ENGLISH_FIXTURE = FIXTURE.with_name("valid-english-lecture.json")


def document():
    return json.loads(FIXTURE.read_text(encoding="utf-8"))


def test_valid_lecture():
    assert validate_document(document()) is None


def test_valid_english_lecture():
    assert validate_document(json.loads(ENGLISH_FIXTURE.read_text(encoding="utf-8"))) is None


def test_legacy_korean_contract():
    legacy = document()
    original = copy.deepcopy(legacy)
    assert validate_document(legacy) is None
    assert legacy == original


@pytest.mark.parametrize(
    ("field", "value", "path"),
    [
        ("missing_translation", None, "/segments/0/translation_ko"),
        ("caption_source", "translated", "/lecture/caption_source"),
        ("translation_language", "en", "/lecture/translation_language"),
    ],
)
def test_invalid_english_lecture(field, value, path):
    doc = json.loads(ENGLISH_FIXTURE.read_text(encoding="utf-8"))
    if field == "missing_translation":
        doc["segments"][0].pop("translation_ko")
    else:
        doc["lecture"][field] = value
    with pytest.raises(ValueError, match=path):
        validate_document(doc)


@pytest.mark.parametrize(
    ("mutate", "path"),
    [
        (lambda doc: doc.pop("summary_note"), "/summary_note"),
        (lambda doc: doc.__setitem__("schema_version", "3.0"), "/schema_version"),
        (lambda doc: doc["outline"]["chapters"][0]["children"][1].__setitem__("start_idx", 4), "/outline/chapters/0/children/1/start_idx"),
        (lambda doc: doc["glossary"][0].__setitem__("first_segment_idx", 9), "/glossary/0/first_segment_idx"),
    ],
)
def test_invalid_lecture(mutate, path):
    doc = copy.deepcopy(document())
    mutate(doc)
    with pytest.raises(ValueError, match=path):
        validate_document(doc)
