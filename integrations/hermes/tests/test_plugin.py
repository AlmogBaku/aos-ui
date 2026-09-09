import json
import sys
import types

from aos_hermes.plugin import register


class FakeContext:
    def __init__(self):
        self.tools = []
        self.sections = []

    def register_tool(self, **kwargs):
        self.tools.append(kwargs)

    def register_system_prompt_section(self, *args, **kwargs):
        self.sections.append((args, kwargs))


def _artifact(tmp_path, monkeypatch):
    artifact = tmp_path / "presentation.json"
    artifact.write_text(json.dumps({
        "tools": [
            {"name": name, "description": name, "parameters": {"type": "object", "properties": {}}}
            for name in ["render_chart", "render_map", "render_stats", "present_plan"]
        ],
        "instructions": "Use structured presentation tools.",
    }))
    monkeypatch.setenv("AOS_HERMES_PRESENTATION_PATH", str(artifact))


def _native_home(tmp_path, monkeypatch, profile_yaml):
    home = tmp_path / "profile"
    home.mkdir()
    (home / "profile.yaml").write_text(profile_yaml)
    constants = types.ModuleType("hermes_constants")
    constants.get_hermes_home = lambda: home
    monkeypatch.setitem(sys.modules, "hermes_constants", constants)
    return home


def test_legacy_plugin_registers_browser_independent_tools_and_prompt(tmp_path, monkeypatch):
    _artifact(tmp_path, monkeypatch)
    _native_home(tmp_path, monkeypatch, "name: researcher\n")
    context = FakeContext()
    register(context)
    assert {tool["name"] for tool in context.tools} == {
        "render_chart", "render_map", "render_stats", "present_plan", "aos_start_session",
        "present_artifact",
    }
    assert context.sections == [(('aos.presentation', 'Use structured presentation tools.'), {
        'position': 'after_memory', 'max_chars': 4000
    })]
    start = next(tool for tool in context.tools if tool["name"] == "aos_start_session")
    assert start["schema"]["parameters"]["required"] == ["profile", "workdir", "prompt"]
    artifact = next(tool for tool in context.tools if tool["name"] == "present_artifact")
    assert artifact["schema"]["parameters"] == {
        "type": "object",
        "properties": {
            "path": {"type": "string", "minLength": 1},
            "title": {"type": "string", "minLength": 1, "maxLength": 255},
            "mimeType": {"type": "string", "minLength": 1, "maxLength": 255},
        },
        "required": ["path"],
        "additionalProperties": False,
    }


def test_artifact_tool_uses_the_calling_session_workdir(tmp_path, monkeypatch):
    _artifact(tmp_path, monkeypatch)
    _native_home(tmp_path, monkeypatch, "name: researcher\n")
    workdir = tmp_path / "workspace"
    workdir.mkdir()
    (workdir / "answer.txt").write_text("forty-two")
    terminal = types.ModuleType("tools.terminal_tool")
    terminal.get_session_cwd = lambda task_id: str(workdir) if task_id == "task-1" else None
    monkeypatch.setitem(sys.modules, "tools.terminal_tool", terminal)
    context = FakeContext()
    register(context)
    tool = next(tool for tool in context.tools if tool["name"] == "present_artifact")

    result = json.loads(tool["handler"](
        {"path": "answer.txt"}, task_id="task-1", session_id="session-1"
    ))

    assert result["ok"] is True
    assert result["artifact"]["path"] == "answer.txt"


def test_artifact_tool_returns_a_rejection_without_native_call_context(tmp_path, monkeypatch):
    _artifact(tmp_path, monkeypatch)
    _native_home(tmp_path, monkeypatch, "name: researcher\n")
    context = FakeContext()
    register(context)
    tool = next(tool for tool in context.tools if tool["name"] == "present_artifact")

    result = json.loads(tool["handler"]({"path": "answer.txt"}))

    assert result == {
        "ok": False,
        "status": "rejected",
        "error": "Artifact publication requires a Session workdir",
    }


def test_creator_tool_requires_explicit_native_creator_metadata(tmp_path, monkeypatch):
    _artifact(tmp_path, monkeypatch)
    home = _native_home(tmp_path, monkeypatch, """
name: creator
ui_meta:
  aos:
    role: creator
  hermes-bots:
    hidden: true
""")
    original = (home / "profile.yaml").read_bytes()
    monkeypatch.setenv("AOS_HERMES_PLUGIN_SOURCE", "file:///srv/aos#integrations/hermes")
    monkeypatch.setenv("AOS_HERMES_PLUGIN_REF", "a" * 40)
    context = FakeContext()
    register(context)
    assert "aos_create_agent" in {tool["name"] for tool in context.tools}
    tool = next(tool for tool in context.tools if tool["name"] == "aos_create_agent")
    result = json.loads(tool["handler"]({
        "profileName": "new-agent",
        "description": "New agent",
        "instructions": "Do work",
        "allowedCapabilities": ["structured-presentations"],
        "confirmed": True,
    }))
    assert result["ok"] is False
    assert result["status"] == "failed"
    assert "atomic public profile create" in result["error"]
    assert (home / "profile.yaml").read_bytes() == original
    assert list(home.iterdir()) == [home / "profile.yaml"]


def test_creator_profile_still_loads_when_creation_source_needs_setup(tmp_path, monkeypatch):
    _artifact(tmp_path, monkeypatch)
    _native_home(tmp_path, monkeypatch, """
name: creator
ui_meta:
  aos:
    role: creator
  hermes-bots:
    hidden: true
""")
    monkeypatch.delenv("AOS_HERMES_PLUGIN_SOURCE", raising=False)
    monkeypatch.delenv("AOS_HERMES_PLUGIN_REF", raising=False)
    context = FakeContext()
    register(context)
    tool = next(tool for tool in context.tools if tool["name"] == "aos_create_agent")
    result = json.loads(tool["handler"]({
        "profileName": "new-agent",
        "description": "New agent",
        "instructions": "Do work",
        "allowedCapabilities": ["structured-presentations"],
        "confirmed": True,
    }))
    assert result == {
        "ok": False,
        "status": "setup-needed",
        "error": "Creator setup requires an immutable Hermes plugin source and full commit ref",
    }


def test_env_flag_cannot_grant_creator_privilege_or_write_native_metadata(tmp_path, monkeypatch):
    _artifact(tmp_path, monkeypatch)
    home = _native_home(tmp_path, monkeypatch, "name: researcher\nui_meta: {}\n")
    original = (home / "profile.yaml").read_bytes()
    monkeypatch.setenv("AOS_HERMES_CREATOR_ENABLED", "1")
    monkeypatch.setenv("AOS_HERMES_PLUGIN_SOURCE", "file:///srv/aos#integrations/hermes")
    monkeypatch.setenv("AOS_HERMES_PLUGIN_REF", "a" * 40)
    context = FakeContext()
    register(context)
    assert "aos_create_agent" not in {tool["name"] for tool in context.tools}
    assert (home / "profile.yaml").read_bytes() == original


def test_plugin_relies_on_native_soul_and_never_reads_proprietary_definition(tmp_path, monkeypatch):
    _artifact(tmp_path, monkeypatch)
    home = _native_home(tmp_path, monkeypatch, "name: researcher\n")
    (home / "SOUL.md").write_text("Native soul")
    (home / "AOS_AGENT.json").write_text(json.dumps({"instructions": "must not load"}))
    context = FakeContext()
    register(context)
    assert all(args[0] != "aos.agent" for args, _kwargs in context.sections)
