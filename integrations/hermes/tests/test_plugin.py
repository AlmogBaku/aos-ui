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
        "render_chart", "render_map", "render_stats", "present_plan", "aos_start_session"
    }
    assert context.sections == [(('aos.presentation', 'Use structured presentation tools.'), {
        'position': 'after_memory', 'max_chars': 4000
    })]
    start = next(tool for tool in context.tools if tool["name"] == "aos_start_session")
    assert start["schema"]["parameters"]["required"] == ["profile", "workdir", "prompt"]


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
