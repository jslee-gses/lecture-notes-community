import copy
import json
from pathlib import Path

import pytest

from server.app.contract import validate_document


FIXTURE = Path(__file__).resolve().parents[2] / "plugins" / "lecture-notes" / "tests" / "fixtures" / "valid-lecture.json"


def document():
    return json.loads(FIXTURE.read_text(encoding="utf-8"))


def test_valid_lecture():
    assert validate_document(document()) is None


@pytest.mark.parametrize(
    ("mutate", "path"),
    [
        (lambda doc: doc.pop("summary_note"), "/summary_note"),
        (lambda doc: doc.__setitem__("schema_version", "2.0"), "/schema_version"),
        (lambda doc: doc["outline"]["chapters"][0]["children"][1].__setitem__("start_idx", 4), "/outline/chapters/0/children/1/start_idx"),
        (lambda doc: doc["glossary"][0].__setitem__("first_segment_idx", 9), "/glossary/0/first_segment_idx"),
    ],
)
def test_invalid_lecture(mutate, path):
    doc = copy.deepcopy(document())
    mutate(doc)
    with pytest.raises(ValueError, match=path):
        validate_document(doc)
