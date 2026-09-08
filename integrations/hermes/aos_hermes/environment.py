from __future__ import annotations

import os


def profile_env(name: str, default: str | None = None) -> str | None:
    """Read Hermes' context-local profile environment without cross-profile fallback."""
    try:
        from agent.secret_scope import get_secret
    except ImportError:
        return os.environ.get(name, default)
    try:
        return get_secret(name, default)
    except RuntimeError:
        # An active multiplexer with no request/profile scope must fail closed.
        return default
