import json

import pytest

from aos_hermes.artifact import ArtifactPublisher


def publisher(workdir):
    return ArtifactPublisher(lambda task_id: str(workdir) if task_id == "task-1" else None)


def test_publishes_a_small_receipt_for_a_regular_session_file(tmp_path):
    report = tmp_path / "reports" / "summary.csv"
    report.parent.mkdir()
    report.write_bytes(b"region,total\nemea,42\n")

    receipt = publisher(tmp_path).publish(
        "reports/summary.csv",
        task_id="task-1",
        session_id="session-1",
        title="Quarterly summary.csv",
        mime_type="text/csv",
    )

    assert receipt == {
        "ok": True,
        "type": "aos.artifact",
        "artifact": {
            "id": receipt["artifact"]["id"],
            "path": "reports/summary.csv",
            "filename": "Quarterly summary.csv",
            "mimeType": "text/csv",
            "sizeBytes": 21,
        },
    }
    assert receipt["artifact"]["id"].startswith("hermes-artifact-")
    assert "region,total" not in json.dumps(receipt)


@pytest.mark.parametrize("path", ["../secret.txt", "reports/../secret.txt"])
def test_rejects_path_traversal(tmp_path, path):
    (tmp_path / "secret.txt").write_text("nope")

    with pytest.raises(ValueError, match="traversal"):
        publisher(tmp_path).publish(
            path, task_id="task-1", session_id="session-1"
        )


@pytest.mark.parametrize("kind", ["file", "parent"])
def test_rejects_symlinks(tmp_path, kind):
    real = tmp_path / "real"
    real.mkdir()
    (real / "report.txt").write_text("hello")
    if kind == "file":
        (tmp_path / "report.txt").symlink_to(real / "report.txt")
        path = "report.txt"
    else:
        (tmp_path / "linked").symlink_to(real, target_is_directory=True)
        path = "linked/report.txt"

    with pytest.raises(ValueError, match="symbolic links"):
        publisher(tmp_path).publish(
            path, task_id="task-1", session_id="session-1"
        )


@pytest.mark.parametrize(
    ("path", "message"),
    [("missing.txt", "existing"), ("reports", "regular file")],
)
def test_rejects_missing_files_and_directories(tmp_path, path, message):
    (tmp_path / "reports").mkdir()

    with pytest.raises(ValueError, match=message):
        publisher(tmp_path).publish(
            path, task_id="task-1", session_id="session-1"
        )


@pytest.mark.parametrize(
    "path",
    [".env", ".ENV.production", ".envrc", "config.yaml", "mcp-tokens/token.json", "pairing/device.json"],
)
def test_rejects_sensitive_paths(tmp_path, path):
    target = tmp_path / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text("secret")

    with pytest.raises(ValueError, match="sensitive"):
        publisher(tmp_path).publish(
            path, task_id="task-1", session_id="session-1"
        )


@pytest.mark.parametrize(
    ("task_id", "session_id"),
    [(None, "session-1"), ("task-1", None), ("other-task", "session-1")],
)
def test_requires_an_explicit_session_workdir(tmp_path, task_id, session_id):
    (tmp_path / "report.txt").write_text("hello")

    with pytest.raises(ValueError, match="Session workdir"):
        publisher(tmp_path).publish(
            "report.txt", task_id=task_id, session_id=session_id
        )


def test_rejects_absolute_paths_even_when_they_are_inside_the_workdir(tmp_path):
    report = tmp_path / "report.txt"
    report.write_text("hello")

    with pytest.raises(ValueError, match="relative"):
        publisher(tmp_path).publish(
            str(report), task_id="task-1", session_id="session-1"
        )


def test_rejects_an_oversized_title(tmp_path):
    (tmp_path / "report.txt").write_text("hello")

    with pytest.raises(ValueError, match="255"):
        publisher(tmp_path).publish(
            "report.txt",
            task_id="task-1",
            session_id="session-1",
            title="x" * 256,
        )
