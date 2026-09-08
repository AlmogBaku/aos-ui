from __future__ import annotations

import os
import re
import subprocess
import tempfile
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable


_PROFILE = re.compile(r"[a-z][a-z0-9-]{1,31}")
_SESSION_ID = re.compile(r"(?m)^session_id:\s*(\S+)\s*$")


@dataclass(frozen=True, slots=True)
class StartSessionConfig:
    hermes_executable: str = "hermes"
    timeout_seconds: int = 1_800


class SessionStarter:
    def __init__(self, config: StartSessionConfig, *,
                 runner: Callable[..., Any] = subprocess.run):
        self.config = config
        self.runner = runner

    @staticmethod
    def _environment() -> dict[str, str]:
        return {
            key: os.environ[key]
            for key in ("PATH", "HOME", "LANG", "LC_ALL")
            if key in os.environ
        }

    def start(self, profile: str, workdir: str, prompt: str, *,
              title: str | None = None) -> dict[str, Any]:
        if not _PROFILE.fullmatch(profile):
            raise ValueError("Profile must be an explicit Hermes profile")
        directory = Path(workdir)
        if not directory.is_absolute() or not directory.is_dir():
            raise ValueError("Workdir must be an existing absolute directory")
        prompt = prompt.strip()
        if not prompt:
            raise ValueError("Prompt is required")
        label = (title or "AOS handoff").strip()[:72] or "AOS handoff"
        unique_title = f"{label} · aos-{uuid.uuid4().hex[:12]}"

        descriptor, query_path = tempfile.mkstemp(prefix="aos-hermes-query-", suffix=".txt")
        try:
            os.fchmod(descriptor, 0o600)
            with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
                handle.write(prompt)
                handle.flush()
                os.fsync(handle.fileno())
            argv = [
                self.config.hermes_executable,
                "-p", profile,
                "chat",
                "--in", str(directory),
                "-c", unique_title,
                "--create-if-missing",
                "-Q",
                "--query-file", query_path,
            ]
            try:
                result = self.runner(
                    argv,
                    capture_output=True,
                    text=True,
                    timeout=self.config.timeout_seconds,
                    check=False,
                    shell=False,
                    env=self._environment(),
                )
            except (OSError, subprocess.TimeoutExpired, TimeoutError):
                return {
                    "ok": False,
                    "status": "uncertain",
                    "profile": profile,
                    "message": "Hermes did not provide a definite completion; do not retry automatically.",
                }
        finally:
            try:
                os.unlink(query_path)
            except FileNotFoundError:
                pass

        match = _SESSION_ID.search(str(result.stderr or ""))
        session_id = match.group(1) if match else None
        if result.returncode == 0 and session_id:
            return {
                "ok": True,
                "status": "completed",
                "profile": profile,
                "sessionId": session_id,
                "title": unique_title,
                "response": str(result.stdout or "").strip(),
            }
        if result.returncode == 0:
            return {
                "ok": False,
                "status": "uncertain",
                "profile": profile,
                "message": (
                    "Hermes completed without reporting its native Session ID; "
                    "do not retry automatically."
                ),
            }
        response: dict[str, Any] = {
            "ok": False,
            "status": "failed",
            "profile": profile,
            "message": "Hermes reported that the Session did not complete successfully.",
        }
        if session_id:
            response["sessionId"] = session_id
            response["title"] = unique_title
        return response
