from __future__ import annotations

import logging
import re
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Protocol, TypeVar

from .start_session import SessionStarter

logger = logging.getLogger(__name__)

CAPABILITY_TOOLSETS = {
    "structured-presentations": "aos-presentation",
    "session-handoff": "aos-session-handoff",
}

# Names Hermes itself or an operator shell may already mean.
RESERVED_NAMES = frozenset({"hermes", "default", "test", "tmp", "root", "sudo"})

HIDDEN_UI_META = {"aos": {"role": "agent"}, "hermes-bots": {"hidden": True}}
INLINE_SECRET_ERROR = (
    "Creator model configuration must reference credentials through environment variables"
)
SETUP_TIMEOUT_SECONDS = 180

T = TypeVar("T")


class ValidationError(ValueError):
    """Plugin-authored rejection text that is safe to show to a user."""


class CreationError(RuntimeError):
    """Native creation failure reported with constant text only."""


class ProfileApi(Protocol):
    """The native profile surface the creator writes through."""

    def model_seed(self) -> dict[str, Any]: ...
    def has_inline_secret(self, seed: dict[str, Any]) -> bool: ...
    def profile_exists(self, name: str) -> bool: ...
    def create_profile(self, name: str, description: str) -> Path: ...
    def verify(self, path: Path) -> bool: ...
    def write_profile_meta(self, path: Path, *, display_name: str, description: str) -> None: ...
    def write_text(self, path: Path, text: str) -> None: ...
    def read_yaml(self, path: Path) -> dict[str, Any]: ...
    def write_yaml(self, path: Path, data: dict[str, Any]) -> None: ...


class NativeProfileApi:
    """Binds lazily to the host Hermes process; importable without it."""

    def model_seed(self) -> dict[str, Any]:
        from hermes_cli.config import read_user_config_raw
        from hermes_cli.profiles import launch_model_seed
        from hermes_constants import get_hermes_home

        return launch_model_seed(read_user_config_raw(Path(get_hermes_home()) / "config.yaml"))

    def has_inline_secret(self, seed: dict[str, Any]) -> bool:
        from hermes_cli.config import redact_config_value

        return redact_config_value(seed) != seed

    def profile_exists(self, name: str) -> bool:
        from hermes_cli.profiles import profile_exists

        return bool(profile_exists(name))

    def create_profile(self, name: str, description: str) -> Path:
        from hermes_cli.profiles import create_profile

        return Path(create_profile(name, description=description, no_alias=True))

    def verify(self, path: Path) -> bool:
        from hermes_constants import named_profile_has_identity

        return path.is_dir() and bool(named_profile_has_identity(path)) and (path / "profile.yaml").is_file()

    def write_profile_meta(self, path: Path, *, display_name: str, description: str) -> None:
        from hermes_cli.profiles import write_profile_meta

        write_profile_meta(
            path, display_name=display_name, description=description, description_auto=False,
        )

    def write_text(self, path: Path, text: str) -> None:
        from utils import atomic_write_text

        atomic_write_text(path, text, preserve_mode=True, create_mode=0o644)

    def read_yaml(self, path: Path) -> dict[str, Any]:
        import yaml

        value = yaml.safe_load(path.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {}

    def write_yaml(self, path: Path, data: dict[str, Any]) -> None:
        from utils import atomic_yaml_write

        atomic_yaml_write(path, data, sort_keys=False)


def creator_environment() -> dict[str, str]:
    from hermes_constants import get_default_hermes_root

    return SessionStarter._environment() | {"HERMES_HOME": str(get_default_hermes_root())}


@dataclass(frozen=True, slots=True)
class CreatorConfig:
    hermes_executable: str
    plugin_source: str
    plugin_ref: str


def _display_name(canon: str) -> str:
    return canon.replace("-", " ").title()


def _validated(profile_name: str, description: str, instructions: str,
               allowed_capabilities: list[str]) -> tuple[str, str, str, list[str]]:
    if not re.fullmatch(r"[a-z][a-z0-9-]{1,31}", profile_name) or profile_name == "default":
        raise ValidationError("Profile name must be 2-32 lowercase letters, digits, or hyphens")
    description, instructions = description.strip(), instructions.strip()
    if not description or len(description) > 300:
        raise ValidationError("Description must be 1-300 characters")
    if not instructions or len(instructions) > 8_000:
        raise ValidationError("Instructions must be 1-8000 characters")
    capabilities = list(dict.fromkeys(allowed_capabilities))
    if not capabilities or any(value not in CAPABILITY_TOOLSETS for value in capabilities):
        raise ValidationError("Allowed capabilities must be an explicit supported non-empty list")
    if profile_name in RESERVED_NAMES:
        raise ValidationError("Profile name is reserved")
    return profile_name, description, instructions, capabilities


def _hidden(meta: dict[str, Any]) -> dict[str, Any]:
    return {
        **meta,
        "ui_meta": HIDDEN_UI_META,
        "_ui_meta_revisions": {"aos": 1, "hermes-bots": 1},
    }


def _revealed(meta: dict[str, Any]) -> dict[str, Any]:
    ui_meta = dict(meta.get("ui_meta") or {})
    ui_meta["hermes-bots"] = {**(ui_meta.get("hermes-bots") or {}), "hidden": False}
    revisions = dict(meta.get("_ui_meta_revisions") or {})
    revisions["hermes-bots"] = 2
    return {**meta, "ui_meta": ui_meta, "_ui_meta_revisions": revisions}


def _enabled_toolsets(config: dict[str, Any], platform: str) -> set[str]:
    platforms = config.get("platform_toolsets")
    values = platforms.get(platform) if isinstance(platforms, dict) else None
    return set(values) if isinstance(values, list) else set()


class Creator:
    def __init__(self, config: CreatorConfig, *,
                 runner: Callable[..., Any] = subprocess.run,
                 profile_api: ProfileApi | None = None,
                 environment: Callable[[], dict[str, str]] = creator_environment):
        if not re.fullmatch(r"[0-9a-f]{40}", config.plugin_ref):
            raise ValueError("Hermes plugin ref must be a full commit SHA")
        self.config = config
        self.runner = runner
        self.profile_api: ProfileApi = profile_api or NativeProfileApi()
        self.environment = environment

    def create(self, profile_name: str, description: str, instructions: str,
               allowed_capabilities: list[str]) -> dict[str, Any]:
        canon, description, instructions, capabilities = _validated(
            profile_name, description, instructions, allowed_capabilities,
        )
        api = self.profile_api
        seed = self._native(api.model_seed)
        if self._native(api.has_inline_secret, seed):
            raise ValidationError(INLINE_SECRET_ERROR)
        if self._native(api.profile_exists, canon):
            raise ValidationError("Profile already exists")

        path = self._native(api.create_profile, canon, description)
        if not self._native(api.verify, path):
            raise CreationError("Profile verification failed")

        profile_yaml = path / "profile.yaml"
        self._native(api.write_yaml, profile_yaml, _hidden(self._native(api.read_yaml, profile_yaml)))
        self._native(api.write_text, path / "SOUL.md", instructions)
        self._native(
            api.write_profile_meta, path,
            display_name=_display_name(canon), description=description,
        )

        toolsets = sorted(CAPABILITY_TOOLSETS[value] for value in capabilities)
        failure = self._setup(canon, toolsets)
        if failure is None and not self._toolsets_enabled(path, toolsets):
            failure = "Toolset enable failed"
        if failure is not None:
            return {"status": "setup-needed", "agentId": canon, "error": failure}

        self._native(api.write_yaml, profile_yaml, _revealed(self._native(api.read_yaml, profile_yaml)))
        return {"status": "ready", "agentId": canon}

    def _native(self, operation: Callable[..., T], *args: Any, **kwargs: Any) -> T:
        """Run one native profile operation; report only constant text on failure."""
        try:
            return operation(*args, **kwargs)
        except Exception:
            logger.exception("Hermes profile operation failed: %s", operation.__name__)
            raise CreationError("Profile creation failed") from None

    def _setup(self, canon: str, toolsets: list[str]) -> str | None:
        """Install, enable, and grant the package; return a constant failure reason."""
        steps = (
            (["plugins", "install", self.config.plugin_source,
              "--ref", self.config.plugin_ref, "--no-enable"], "Plugin install failed"),
            (["plugins", "enable", "aos-integration", "--no-allow-tool-override"],
             "Plugin enable failed"),
            (["tools", "enable", "--platform", "api_server", *toolsets], "Toolset enable failed"),
            (["tools", "enable", "--platform", "cli", *toolsets], "Toolset enable failed"),
        )
        for arguments, failure in steps:
            reason = self._step([self.config.hermes_executable, "-p", canon, *arguments], failure)
            if reason is not None:
                return reason
        return None

    def _step(self, argv: list[str], failure: str) -> str | None:
        try:
            result = self.runner(
                argv, env=self.environment(), check=False,
                timeout=SETUP_TIMEOUT_SECONDS, capture_output=True, text=True,
            )
        except subprocess.TimeoutExpired:
            logger.warning("Hermes creator step timed out: %s", argv)
            return "Plugin setup timed out"
        except OSError:
            logger.exception("Hermes creator step could not start: %s", argv)
            return failure
        if result.returncode != 0:
            logger.error(
                "Hermes creator step failed (%s): %s: %s",
                result.returncode, argv, result.stderr,
            )
            return failure
        return None

    def _toolsets_enabled(self, path: Path, toolsets: list[str]) -> bool:
        config = self._native(self.profile_api.read_yaml, path / "config.yaml")
        return all(
            set(toolsets) <= _enabled_toolsets(config, platform)
            for platform in ("api_server", "cli")
        )
