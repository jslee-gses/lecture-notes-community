"""Public repository and portable plugin layout checks."""

import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
PLUGIN = ROOT / "plugins" / "lecture-notes"


def test_marketplace_points_to_installable_plugin():
    catalog = json.loads((ROOT / ".agents" / "plugins" / "marketplace.json").read_text(encoding="utf-8"))
    assert catalog["name"] == "lecture-notes-community"
    entry = catalog["plugins"][0]
    assert entry["source"] == {"source": "local", "path": "./plugins/lecture-notes"}
    assert entry["policy"]["installation"] == "AVAILABLE"
    assert entry["policy"]["authentication"] == "ON_INSTALL"
    manifest = json.loads((PLUGIN / "plugin.json").read_text(encoding="utf-8"))
    assert manifest["name"] == entry["name"]
    assert manifest["version"]
    assert (PLUGIN / "skills" / "lecture-notes" / "SKILL.md").is_file()
    assert (PLUGIN / "scripts" / "cli.ts").is_file()
    assert (PLUGIN / "scripts" / "upload.ts").is_file()
    assert (PLUGIN / "schema" / "lecture.schema.json").is_file()
    assert (PLUGIN / "tools" / "bootstrap.ps1").is_file()
    server = json.loads((PLUGIN / "server.json").read_text(encoding="utf-8"))
    assert server["base_url"].startswith("https://")


def test_no_private_material_in_plugin_package():
    paths = [path.relative_to(PLUGIN).as_posix() for path in PLUGIN.rglob("*") if path.is_file()]
    assert paths
    assert not any(".env" in path or "secret" in path.lower() or "token" in path.lower() for path in paths)
