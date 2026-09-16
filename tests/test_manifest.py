from pathlib import Path

import yaml

MANIFEST = Path(__file__).resolve().parents[1] / "plugin" / "plugin.yaml"


def test_hard_and_soft_dependencies():
    data = yaml.safe_load(MANIFEST.read_text(encoding="utf-8"))
    assert data["dependencies"] == ["memory"]
    soft = {d["name"]: d.get("enables", "") for d in data["soft_dependencies"]}
    assert soft == {"chat": "conversation count in stats"}
