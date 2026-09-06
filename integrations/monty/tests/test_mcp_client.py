"""Tests for backend MCP config validation."""

import json
from pathlib import Path

import pytest

from monty.mcp_client import load_backend_params


def _write_config(tmp_path: Path, data: dict) -> Path:
    config_path = tmp_path / "backend.json"
    config_path.write_text(json.dumps(data), encoding="utf-8")
    return config_path


def test_load_backend_params_requires_args_list_of_strings(tmp_path: Path) -> None:
    config_path = _write_config(tmp_path, {"command": "uv", "args": "run math-server"})

    with pytest.raises(SystemExit, match="Invalid 'args'"):
        load_backend_params(config_path)


def test_load_backend_params_rejects_invalid_command_type(tmp_path: Path) -> None:
    config_path = _write_config(tmp_path, {"command": 123, "args": ["run", "math-server"]})

    with pytest.raises(SystemExit, match="Invalid 'command'"):
        load_backend_params(config_path)


def test_load_backend_params_accepts_valid_config(tmp_path: Path) -> None:
    config_path = _write_config(tmp_path, {"command": "uv", "args": ["run", "math-server"]})

    params = load_backend_params(config_path)
    assert params.command == "uv"
    assert params.args == ["run", "math-server"]
