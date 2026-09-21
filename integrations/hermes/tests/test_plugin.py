import json
import sys
import types
from pathlib import Path

from aos_hermes.creator import Creator, ValidationError
from aos_hermes.plugin import register


class FakeContext:
    def __init__(self):
        self.tools = []
        self.sections = []
        self.skills = []

    def register_tool(self, **kwargs):
        self.tools.append(kwargs)

    def register_system_prompt_section(self, *args, **kwargs):
        self.sections.append((args, kwargs))

    def register_skill(self, *args, **kwargs):
        self.skills.append((args, kwargs))


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
    assert [args[0] for args, _ in context.sections] == [
        "aos.presentation",
        "aos.invite_link",
    ]
    for args, kwargs in context.sections:
        assert isinstance(args[1], str) and args[1].strip()
        assert kwargs["position"] == "after_memory"
        assert isinstance(kwargs["max_chars"], int) and kwargs["max_chars"] > 0
    assert "aos-invite-link" in context.sections[1][0][1]
    assert len(context.skills) == 1
    args, kwargs = context.skills[0]
    assert args == ()
    assert kwargs["name"] == "aos-invite-link"
    assert isinstance(kwargs["path"], Path)
    assert Path(kwargs["path"]).name == "invite-link.md"
    assert isinstance(kwargs["description"], str) and kwargs["description"].strip()
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


def test_artifact_tool_uses_native_runtime_cwd_before_any_terminal_call(tmp_path, monkeypatch):
    _artifact(tmp_path, monkeypatch)
    _native_home(tmp_path, monkeypatch, "name: researcher\n")
    workdir = tmp_path / "workspace"
    workdir.mkdir()
    (workdir / "answer.txt").write_text("forty-two")
    terminal = types.ModuleType("tools.terminal_tool")
    terminal.get_session_cwd = lambda _task_id: None
    monkeypatch.setitem(sys.modules, "tools.terminal_tool", terminal)
    runtime_cwd = types.ModuleType("agent.runtime_cwd")
    runtime_cwd.resolve_agent_cwd = lambda: workdir
    monkeypatch.setitem(sys.modules, "agent.runtime_cwd", runtime_cwd)
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


CREATOR_METADATA = """
name: creator
ui_meta:
  aos:
    role: creator
  hermes-bots:
    hidden: true
"""


def test_creator_loads_its_interview_from_a_skill_file(tmp_path, monkeypatch):
    _artifact(tmp_path, monkeypatch)
    _native_home(tmp_path, monkeypatch, CREATOR_METADATA)
    monkeypatch.setenv("AOS_HERMES_PLUGIN_SOURCE", "file:///srv/aos#integrations/hermes")
    monkeypatch.setenv("AOS_HERMES_PLUGIN_REF", "a" * 40)
    context = FakeContext()

    register(context)

    creator = next(
        kwargs for _args, kwargs in context.skills
        if kwargs["name"] == "aos-agent-creator"
    )
    assert Path(creator["path"]).name == "agent-creator.md"
    assert Path(creator["path"]).is_file()
    assert creator["description"].strip()
    pointer = next(
        args[1] for args, _kwargs in context.sections
        if args[0] == "aos.agent_creator"
    )
    # The prompt points at the skill; it does not carry the interview itself.
    assert "aos-agent-creator" in pointer
    assert "Establish the Agent's purpose" not in pointer


def _creator_tool(tmp_path, monkeypatch, *, configured=True):
    _artifact(tmp_path, monkeypatch)
    home = _native_home(tmp_path, monkeypatch, CREATOR_METADATA)
    if configured:
        monkeypatch.setenv("AOS_HERMES_PLUGIN_SOURCE", "file:///srv/aos#integrations/hermes")
        monkeypatch.setenv("AOS_HERMES_PLUGIN_REF", "a" * 40)
    else:
        monkeypatch.delenv("AOS_HERMES_PLUGIN_SOURCE", raising=False)
        monkeypatch.delenv("AOS_HERMES_PLUGIN_REF", raising=False)
    context = FakeContext()
    register(context)
    assert "aos_create_agent" in {tool["name"] for tool in context.tools}
    tool = next(tool for tool in context.tools if tool["name"] == "aos_create_agent")
    return home, tool


def _create_agent(tool, **overrides):
    return json.loads(tool["handler"]({
        "profileName": "new-agent",
        "description": "New agent",
        "instructions": "Do work",
        "allowedCapabilities": ["structured-presentations"],
        "confirmed": True,
        **overrides,
    }))


def _raising(error):
    def create(*_args, **_kwargs):
        raise error
    return create


def test_creator_tool_requires_explicit_native_creator_metadata(tmp_path, monkeypatch):
    home, tool = _creator_tool(tmp_path, monkeypatch)
    original = (home / "profile.yaml").read_bytes()

    assert _create_agent(tool, confirmed=False) == {
        "ok": False,
        "status": "failed",
        "error": "Explicit confirmation is required",
    }
    assert (home / "profile.yaml").read_bytes() == original
    assert list(home.iterdir()) == [home / "profile.yaml"]


def test_creator_reports_a_ready_profile(tmp_path, monkeypatch):
    _home, tool = _creator_tool(tmp_path, monkeypatch)
    monkeypatch.setattr(
        Creator, "create",
        lambda *_args, **_kwargs: {"status": "ready", "agentId": "new-agent"},
    )

    assert _create_agent(tool) == {"ok": True, "status": "ready", "agentId": "new-agent"}


def test_creator_reports_setup_needed_without_ok(tmp_path, monkeypatch):
    _home, tool = _creator_tool(tmp_path, monkeypatch)
    monkeypatch.setattr(Creator, "create", lambda *_args, **_kwargs: {
        "status": "setup-needed", "agentId": "new-agent", "error": "Plugin install failed",
    })

    assert _create_agent(tool) == {
        "ok": False,
        "status": "setup-needed",
        "agentId": "new-agent",
        "error": "Plugin install failed",
    }


def test_creator_validation_text_reaches_the_caller(tmp_path, monkeypatch):
    _home, tool = _creator_tool(tmp_path, monkeypatch)
    monkeypatch.setattr(Creator, "create", _raising(ValidationError("Profile already exists")))

    assert _create_agent(tool) == {
        "ok": False,
        "status": "failed",
        "error": "Profile already exists",
    }


def test_unexpected_creator_failure_reports_a_path_free_error(tmp_path, monkeypatch):
    _home, tool = _creator_tool(tmp_path, monkeypatch)
    monkeypatch.setattr(Creator, "create", _raising(PermissionError("/home/x/.hermes/profiles")))

    result = _create_agent(tool)

    assert result == {"ok": False, "status": "failed", "error": "Profile creation failed"}
    assert "/" not in json.dumps(result)


def test_plain_value_error_is_never_shown_to_the_caller(tmp_path, monkeypatch):
    _home, tool = _creator_tool(tmp_path, monkeypatch)
    monkeypatch.setattr(Creator, "create", _raising(ValueError("/home/x is invalid")))

    result = _create_agent(tool)

    assert result == {"ok": False, "status": "failed", "error": "Profile creation failed"}
    assert "/" not in json.dumps(result)


def test_creator_profile_still_loads_when_creation_source_needs_setup(tmp_path, monkeypatch):
    _home, tool = _creator_tool(tmp_path, monkeypatch, configured=False)

    assert _create_agent(tool) == {
        "ok": False,
        "status": "setup-needed",
        "error": (
            "Creator setup requires AOS_HERMES_PLUGIN_SOURCE "
            "and a full-commit AOS_HERMES_PLUGIN_REF"
        ),
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
