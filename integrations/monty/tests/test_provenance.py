from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_fork_preserves_upstream_attribution() -> None:
    provenance = (ROOT / "UPSTREAM.md").read_text()
    license_text = (ROOT / "LICENSE").read_text()
    assert "https://github.com/DevonFulcher/monty-mcp" in provenance
    assert "MIT License" in license_text
    assert "Copyright (c) 2026 Devon Fulcher" in license_text
