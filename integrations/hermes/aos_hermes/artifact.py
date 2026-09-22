from __future__ import annotations

import mimetypes
import re
import stat
import uuid
from pathlib import Path, PurePosixPath, PureWindowsPath
from typing import Callable


_SENSITIVE_FILE_NAMES = frozenset({
    "auth.json", "auth.lock", "credentials", "config.yaml",
    ".anthropic_oauth.json", "google_token.json", "google_oauth_pending.json",
    "google_oauth.json", "webhook_subscriptions.json", "bws_cache.json",
    "bws_cache.enc.json", ".git-credentials",
})
_SENSITIVE_DIRECTORY_NAMES = frozenset({"mcp-tokens", "pairing"})
_MIME_TYPE = re.compile(r"^[^\s/;]+/[^\s;]+(?:\s*;[^\r\n]+)?$")


def _session_workdir(task_id: str) -> str | None:
    try:
        from tools.terminal_tool import get_session_cwd

        if recorded := get_session_cwd(task_id):
            return recorded
    except (ImportError, RuntimeError, TypeError, ValueError):
        pass
    try:
        from agent.runtime_cwd import resolve_agent_cwd

        return str(resolve_agent_cwd())
    except (ImportError, OSError, RuntimeError, TypeError, ValueError):
        return None


def _sensitive(path: PurePosixPath) -> bool:
    lowered = path.name.lower()
    return (
        lowered == ".env"
        or lowered.startswith(".env.")
        or lowered == ".envrc"
        or lowered in _SENSITIVE_FILE_NAMES
        or any(part.lower() in _SENSITIVE_DIRECTORY_NAMES for part in path.parts)
    )


class ArtifactPublisher:
    def __init__(self, workdir: Callable[[str], str | None] = _session_workdir):
        self.workdir = workdir

    def publish(
        self,
        path: str,
        *,
        task_id: str | None,
        session_id: str | None,
        title: str | None = None,
        mime_type: str | None = None,
    ) -> dict[str, object]:
        if not task_id or not session_id:
            raise ValueError("Artifact publication requires a Session workdir")
        raw_workdir = self.workdir(task_id)
        if not raw_workdir:
            raise ValueError("Artifact publication requires a Session workdir")

        value = str(path or "").strip()
        portable = PurePosixPath(value.replace("\\", "/"))
        if not value or Path(value).is_absolute() or PureWindowsPath(value).is_absolute():
            raise ValueError("Artifact path must be relative to the Session workdir")
        if ".." in portable.parts:
            raise ValueError("Artifact path traversal is not allowed")
        if _sensitive(portable):
            raise ValueError("Artifact path is sensitive and cannot be published")

        root = Path(raw_workdir)
        if not root.is_absolute() or not root.is_dir():
            raise ValueError("Artifact publication requires a Session workdir")
        target = root.joinpath(*portable.parts)
        current = root
        for part in portable.parts:
            current = current / part
            if current.is_symlink():
                raise ValueError("Artifact paths cannot contain symbolic links")
        try:
            status = target.stat()
        except (FileNotFoundError, NotADirectoryError) as exc:
            raise ValueError("Artifact path must name an existing file") from exc
        except OSError as exc:
            raise ValueError("Artifact path could not be inspected") from exc
        if not stat.S_ISREG(status.st_mode):
            raise ValueError("Artifact path must name a regular file")

        filename = (title or target.name).strip()
        if not filename or "/" in filename or "\\" in filename:
            raise ValueError("Artifact title must be a filename")
        if len(filename) > 255:
            raise ValueError("Artifact title must contain at most 255 characters")
        mime = mime_type.strip() if mime_type is not None else None
        if mime is not None and not _MIME_TYPE.fullmatch(mime):
            raise ValueError("Artifact MIME type is invalid")
        if mime is None:
            mime = mimetypes.guess_type(target.name)[0]

        # The provider's file reader resolves a relative path only against the
        # Session's persisted cwd, which Hermes leaves empty for many Sessions.
        # Carrying the validated root lets the proxy read by absolute path.
        artifact: dict[str, object] = {
            "id": f"hermes-artifact-{uuid.uuid4().hex}",
            "workdir": str(root),
            "path": portable.as_posix(),
            "filename": filename,
            "sizeBytes": status.st_size,
        }
        if mime:
            artifact["mimeType"] = mime
        return {"ok": True, "type": "aos.artifact", "artifact": artifact}
