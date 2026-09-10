import subprocess
import shutil
import zipfile
from pathlib import Path

import yaml


def test_plugin_manifest_declares_artifact_tool():
    root = Path(__file__).parents[1]
    manifest = yaml.safe_load((root / "plugin.yaml").read_text(encoding="utf-8"))

    assert "present_artifact" in manifest["provides_tools"]


def test_wheel_contains_generated_native_assets(tmp_path):
    root = Path(__file__).parents[1]
    source = tmp_path / "source"
    shutil.copytree(
        root,
        source,
        ignore=shutil.ignore_patterns(".venv", "dist", "build", "*.egg-info", "__pycache__"),
    )
    output = tmp_path / "wheel"
    subprocess.run(
        ["uv", "build", "--wheel", "--out-dir", str(output)],
        cwd=source,
        check=True,
        capture_output=True,
        text=True,
        timeout=60,
    )
    wheel = next(output.glob("*.whl"))
    with zipfile.ZipFile(wheel) as archive:
        names = set(archive.namelist())
    assert "aos_hermes/_generated/presentation.json" in names
    assert "aos_hermes/_generated/agent-creator.md" in names
    assert "aos_hermes/_generated/invite-link.md" in names
