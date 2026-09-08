from __future__ import annotations

import re
import subprocess
from dataclasses import dataclass
from typing import Any, Callable


CAPABILITY_TOOLSETS = {
    "structured-presentations": "aos-presentation",
    "session-handoff": "aos-session-handoff",
}


@dataclass(frozen=True, slots=True)
class CreatorConfig:
    hermes_executable: str
    plugin_source: str
    plugin_ref: str


class Creator:
    def __init__(self, config: CreatorConfig, *,
                 runner: Callable[..., Any] = subprocess.run):
        if not re.fullmatch(r"[0-9a-f]{40}", config.plugin_ref):
            raise ValueError("Hermes plugin ref must be a full commit SHA")
        self.config = config
        self.runner = runner

    def create(self, profile_name: str, description: str, instructions: str,
               allowed_capabilities: list[str]) -> dict[str, Any]:
        if not re.fullmatch(r"[a-z][a-z0-9-]{1,31}", profile_name) or profile_name == "default":
            raise ValueError("Profile name must be 2-32 lowercase letters, digits, or hyphens")
        description, instructions = description.strip(), instructions.strip()
        if not description or len(description) > 300:
            raise ValueError("Description must be 1-300 characters")
        if not instructions or len(instructions) > 8_000:
            raise ValueError("Instructions must be 1-8000 characters")
        capabilities = list(dict.fromkeys(allowed_capabilities))
        if not capabilities or any(value not in CAPABILITY_TOOLSETS for value in capabilities):
            raise ValueError("Allowed capabilities must be an explicit supported non-empty list")

        # Hermes b29b352 checks existence before creating the profile directory
        # with exist_ok=True. Concurrent creators can therefore both pass the
        # check and write one definition. Fail closed until Hermes exposes an
        # atomic, no-overwrite public create operation.
        raise RuntimeError(
            "Automated Hermes Agent creation is unavailable: Hermes must provide "
            "an atomic public profile create operation that never overwrites a "
            "concurrently created profile"
        )
