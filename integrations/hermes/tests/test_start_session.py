import json
from pathlib import Path

from aos_hermes.start_session import SessionStarter, StartSessionConfig


def _result(returncode=0, stdout="", stderr=""):
    return type("Result", (), {
        "returncode": returncode, "stdout": stdout, "stderr": stderr,
    })()


def test_start_session_uses_direct_argv_secure_query_file_and_native_id(tmp_path):
    workdir = tmp_path / "worktree"
    workdir.mkdir()
    calls = []

    def run(argv, **kwargs):
        query_path = Path(argv[-1])
        calls.append((argv, kwargs, query_path.read_text(), query_path.stat().st_mode & 0o777))
        return _result(stdout="Completed research", stderr="\nsession_id: 20260908_120000_a1b2c3\n")

    starter = SessionStarter(StartSessionConfig("hermes"), runner=run)
    result = starter.start("researcher", str(workdir), "Investigate this", title="Handoff")

    argv, kwargs, prompt, mode = calls[0]
    assert argv[:7] == [
        "hermes", "-p", "researcher", "chat", "--in", str(workdir), "-c",
    ]
    assert argv[7].startswith("Handoff · aos-")
    assert argv[8:] == ["--create-if-missing", "-Q", "--query-file", argv[-1]]
    assert kwargs["shell"] is False
    assert prompt == "Investigate this"
    assert mode == 0o600
    assert not Path(argv[-1]).exists()
    assert result == {
        "ok": True,
        "status": "completed",
        "profile": "researcher",
        "sessionId": "20260908_120000_a1b2c3",
        "title": argv[7],
        "response": "Completed research",
    }


def test_start_session_reports_native_failure_with_created_session_and_never_retries(tmp_path):
    workdir = tmp_path / "worktree"
    workdir.mkdir()
    calls = []

    def run(argv, **kwargs):
        calls.append(argv)
        return _result(returncode=1, stderr="provider rejected request\nsession_id: native-123\n")

    result = SessionStarter(StartSessionConfig("hermes"), runner=run).start(
        "researcher", str(workdir), "Investigate",
    )
    assert len(calls) == 1
    assert result["ok"] is False
    assert result["status"] == "failed"
    assert result["sessionId"] == "native-123"
    assert "provider rejected" not in json.dumps(result)


def test_start_session_reports_uncertainty_without_retry(tmp_path):
    workdir = tmp_path / "worktree"
    workdir.mkdir()
    calls = []

    def run(argv, **kwargs):
        calls.append(argv)
        raise TimeoutError("completion unknown")

    result = SessionStarter(StartSessionConfig("hermes"), runner=run).start(
        "researcher", str(workdir), "Investigate",
    )
    assert len(calls) == 1
    assert result == {
        "ok": False,
        "status": "uncertain",
        "profile": "researcher",
        "message": "Hermes did not provide a definite completion; do not retry automatically.",
    }


def test_start_session_treats_success_without_native_session_id_as_uncertain(tmp_path):
    workdir = tmp_path / "worktree"
    workdir.mkdir()
    calls = []

    def run(argv, **kwargs):
        calls.append(argv)
        return _result(returncode=0, stdout="response", stderr="completion line missing")

    result = SessionStarter(StartSessionConfig("hermes"), runner=run).start(
        "researcher", str(workdir), "Investigate",
    )
    assert len(calls) == 1
    assert result == {
        "ok": False,
        "status": "uncertain",
        "profile": "researcher",
        "message": "Hermes completed without reporting its native Session ID; do not retry automatically.",
    }


def test_start_session_requires_explicit_profile_workdir_and_prompt(tmp_path):
    starter = SessionStarter(StartSessionConfig("hermes"), runner=lambda *_a, **_k: None)
    invalid = [
        ("../escape", str(tmp_path), "prompt"),
        ("researcher", "relative", "prompt"),
        ("researcher", str(tmp_path / "missing"), "prompt"),
        ("researcher", str(tmp_path), "  "),
    ]
    for args in invalid:
        try:
            starter.start(*args)
        except ValueError:
            pass
        else:
            raise AssertionError(f"invalid start accepted: {args}")


def test_start_session_accepts_explicit_default_profile(tmp_path):
    calls = []

    def run(argv, **kwargs):
        calls.append(argv)
        return _result(stderr="session_id: native-default")

    result = SessionStarter(StartSessionConfig("hermes"), runner=run).start(
        "default", str(tmp_path), "Investigate",
    )
    assert calls[0][1:3] == ["-p", "default"]
    assert result["sessionId"] == "native-default"
