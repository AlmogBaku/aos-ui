import json
import subprocess
from pathlib import Path

import pytest

from aos_hermes.creator import CreationError, Creator, CreatorConfig, ValidationError

CAPABILITIES = ["structured-presentations", "session-handoff"]
TOOLSETS = ["aos-presentation", "aos-session-handoff"]
PROFILE = Path("/home/agent/.hermes/profiles/data-helper")
SOURCE = "file:///srv/aos#integrations/hermes"
REF = "a" * 40
ENVIRONMENT = {"PATH": "/usr/bin", "HERMES_HOME": "/home/agent/.hermes"}
DESCRIPTION = "A careful data agent"
INSTRUCTIONS = "Research carefully and cite evidence."
INLINE_SECRET_ERROR = "Creator model configuration must reference credentials through environment variables"


class FakeProfileApi:
    def __init__(self, *, inline_secret=False, exists=False, verified=True,
                 create_error=None, config_yaml=None, reserved=frozenset()):
        self.reserved = frozenset(reserved)
        self.inline_secret = inline_secret
        self.exists = exists
        self.verified = verified
        self.create_error = create_error
        self.calls: list[str] = []
        self.yaml_writes: list[tuple[Path, dict]] = []
        self.texts: dict[Path, str] = {}
        self.meta: dict | None = None
        self.files: dict[Path, dict] = {
            PROFILE / "profile.yaml": {"name": "data-helper"},
            PROFILE / "config.yaml": {
                "platform_toolsets": {"api_server": list(TOOLSETS), "cli": list(TOOLSETS)},
            } if config_yaml is None else config_yaml,
        }

    def reserved_names(self):
        self.calls.append("reserved_names")
        return self.reserved

    def model_seed(self):
        self.calls.append("model_seed")
        return {"model": {"provider": "gateway"}}

    def has_inline_secret(self, seed):
        self.calls.append("has_inline_secret")
        assert seed == {"model": {"provider": "gateway"}}
        return self.inline_secret

    def profile_exists(self, name):
        self.calls.append("profile_exists")
        return self.exists

    def create_profile(self, name, description):
        self.calls.append("create_profile")
        if self.create_error is not None:
            raise self.create_error
        return PROFILE

    def verify(self, path):
        self.calls.append("verify")
        return self.verified

    def write_profile_meta(self, path, *, display_name, description):
        self.calls.append("write_profile_meta")
        self.meta = {"path": path, "display_name": display_name, "description": description}

    def write_text(self, path, text):
        self.calls.append("write_text")
        self.texts[path] = text

    def read_yaml(self, path):
        self.calls.append(f"read_yaml:{path.name}")
        return json.loads(json.dumps(self.files.get(path, {})))

    def write_yaml(self, path, data):
        self.calls.append(f"write_yaml:{path.name}")
        stored = json.loads(json.dumps(data))
        self.files[path] = stored
        self.yaml_writes.append((path, stored))


class FakeRunner:
    def __init__(self, results=None, raises=None):
        self.results = list(results or [])
        self.raises = raises
        self.calls: list[tuple[list[str], dict]] = []

    def __call__(self, argv, **kwargs):
        self.calls.append((list(argv), kwargs))
        if self.raises is not None:
            raise self.raises
        if self.results:
            return self.results.pop(0)
        return subprocess.CompletedProcess(argv, 0, "", "")


def _creator(api, runner=None):
    return Creator(
        CreatorConfig("hermes", SOURCE, REF),
        runner=runner or FakeRunner(),
        profile_api=api,
        environment=lambda: dict(ENVIRONMENT),
    )


def _create(creator, name="data-helper", capabilities=None):
    return creator.create(name, DESCRIPTION, INSTRUCTIONS, capabilities or CAPABILITIES)


def _expected_argv():
    return [
        ["hermes", "-p", "data-helper", "plugins", "install", SOURCE, "--ref", REF, "--no-enable"],
        ["hermes", "-p", "data-helper", "plugins", "enable", "aos-integration", "--no-allow-tool-override"],
        ["hermes", "-p", "data-helper", "tools", "enable", "--platform", "api_server", *TOOLSETS],
        ["hermes", "-p", "data-helper", "tools", "enable", "--platform", "cli", *TOOLSETS],
    ]


def test_create_writes_hidden_profile_then_reveals_and_returns_ready():
    api, runner = FakeProfileApi(), FakeRunner()

    result = _create(_creator(api, runner))

    assert result == {"status": "ready", "agentId": "data-helper"}
    assert "/" not in json.dumps(result)

    hidden_write = api.calls.index("write_yaml:profile.yaml")
    assert hidden_write < api.calls.index("write_text")
    assert hidden_write < api.calls.index("write_profile_meta")
    assert api.texts == {PROFILE / "SOUL.md": INSTRUCTIONS}
    assert api.meta == {
        "path": PROFILE,
        "display_name": "Data Helper",
        "description": DESCRIPTION,
    }

    assert api.yaml_writes[0] == (PROFILE / "profile.yaml", {
        "name": "data-helper",
        "ui_meta": {"aos": {"role": "agent"}, "hermes-bots": {"hidden": True}},
        "_ui_meta_revisions": {"aos": 1, "hermes-bots": 1},
    })

    assert [argv for argv, _ in runner.calls] == _expected_argv()
    for _argv, kwargs in runner.calls:
        assert kwargs == {
            "env": ENVIRONMENT,
            "check": False,
            "timeout": 180,
            "capture_output": True,
            "text": True,
        }

    assert api.yaml_writes[-1] == (PROFILE / "profile.yaml", {
        "name": "data-helper",
        "ui_meta": {"aos": {"role": "agent"}, "hermes-bots": {"hidden": False}},
        "_ui_meta_revisions": {"aos": 1, "hermes-bots": 2},
    })


def test_refuses_when_creator_model_config_has_inline_secret():
    api, runner = FakeProfileApi(inline_secret=True), FakeRunner()

    with pytest.raises(ValidationError, match=INLINE_SECRET_ERROR):
        _create(_creator(api, runner))

    assert "create_profile" not in api.calls
    assert api.yaml_writes == [] and api.texts == {} and runner.calls == []


def test_allows_env_reference_credentials():
    api = FakeProfileApi(inline_secret=False)

    assert _create(_creator(api)) == {"status": "ready", "agentId": "data-helper"}


def test_existing_name_rejected_before_create():
    api, runner = FakeProfileApi(exists=True), FakeRunner()

    with pytest.raises(ValidationError, match="Profile already exists"):
        _create(_creator(api, runner))

    assert "create_profile" not in api.calls
    assert api.yaml_writes == [] and runner.calls == []


def test_reserved_name_rejected_before_create():
    api = FakeProfileApi(reserved=frozenset({"tmp"}))
    runner = FakeRunner()

    with pytest.raises(ValidationError, match="Profile name is reserved"):
        _create(_creator(api, runner), name="tmp")

    assert api.calls == ["reserved_names"] and runner.calls == []


def test_create_race_reports_constant_error():
    api = FakeProfileApi(
        create_error=FileExistsError("/home/x/.hermes/profiles/data-helper exists"),
    )
    runner = FakeRunner()

    with pytest.raises(CreationError) as raised:
        _create(_creator(api, runner))

    assert str(raised.value) == "Profile creation failed"
    assert "/" not in str(raised.value)
    assert api.yaml_writes == [] and api.texts == {} and api.meta is None
    assert runner.calls == []


def test_upstream_value_error_is_remapped():
    api = FakeProfileApi(create_error=ValueError("Profile 'x' at /home/x is invalid"))

    with pytest.raises(CreationError) as raised:
        _create(_creator(api))

    assert str(raised.value) == "Profile creation failed"


def test_verify_failure_reports_constant_error():
    api, runner = FakeProfileApi(verified=False), FakeRunner()

    with pytest.raises(CreationError) as raised:
        _create(_creator(api, runner))

    assert str(raised.value) == "Profile verification failed"
    assert api.yaml_writes == [] and api.texts == {} and runner.calls == []


def test_plugin_install_failure_is_setup_needed_and_profile_stays_hidden():
    api = FakeProfileApi()
    runner = FakeRunner(results=[
        subprocess.CompletedProcess(["hermes"], 1, "", "fatal: /home/x file:///srv"),
    ])

    result = _create(_creator(api, runner))

    assert result == {
        "status": "setup-needed",
        "agentId": "data-helper",
        "error": "Plugin install failed",
    }
    assert "/" not in json.dumps(result)
    assert len(runner.calls) == 1
    assert api.files[PROFILE / "profile.yaml"]["ui_meta"]["hermes-bots"]["hidden"] is True


def test_timeout_is_setup_needed():
    api = FakeProfileApi()
    runner = FakeRunner(raises=subprocess.TimeoutExpired(cmd=["hermes"], timeout=180))

    result = _create(_creator(api, runner))

    assert result == {
        "status": "setup-needed",
        "agentId": "data-helper",
        "error": "Plugin setup timed out",
    }


def test_missing_hermes_executable_is_setup_needed():
    api = FakeProfileApi()
    runner = FakeRunner(raises=FileNotFoundError("/usr/local/bin/hermes"))

    result = _create(_creator(api, runner))

    assert result == {
        "status": "setup-needed",
        "agentId": "data-helper",
        "error": "Plugin install failed",
    }
    assert "/" not in json.dumps(result)


def test_ready_requires_toolsets_in_both_platforms():
    api = FakeProfileApi(config_yaml={
        "platform_toolsets": {"api_server": list(TOOLSETS), "cli": ["aos-session-handoff"]},
    })
    runner = FakeRunner()

    result = _create(_creator(api, runner))

    assert result == {
        "status": "setup-needed",
        "agentId": "data-helper",
        "error": "Toolset enable failed",
    }
    assert len(runner.calls) == 4
    assert api.files[PROFILE / "profile.yaml"]["ui_meta"]["hermes-bots"]["hidden"] is True


def test_aos_toolset_never_enabled():
    api, runner = FakeProfileApi(), FakeRunner()

    _create(_creator(api, runner))

    for argv, _kwargs in runner.calls[2:]:
        assert argv[argv.index("--platform") + 2:] == TOOLSETS


def test_post_publish_write_failure_is_setup_needed():
    api = FakeProfileApi()
    original_write_text = api.write_text

    def failing_write_text(path, text):
        raise OSError("/home/x: permission denied")

    api.write_text = failing_write_text
    runner = FakeRunner()

    result = _create(_creator(api, runner))

    assert result == {
        "status": "setup-needed",
        "agentId": "data-helper",
        "error": "Profile creation failed",
    }
    assert "/" not in json.dumps(result)
    assert runner.calls == []


def test_creator_rejects_unsafe_profile_and_invalid_capabilities():
    creator = Creator(
        CreatorConfig("hermes", SOURCE, "b" * 40),
        runner=lambda *_args, **_kwargs: None,
        profile_api=FakeProfileApi(),
    )
    for name in ("default", "../escape", "A"):
        with pytest.raises(ValueError):
            creator.create(name, "Agent", "Do work", ["structured-presentations"])

    with pytest.raises(ValueError):
        creator.create("safe-agent", "Agent", "Do work", ["shell"])
