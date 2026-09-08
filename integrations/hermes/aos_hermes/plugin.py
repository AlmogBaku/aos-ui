from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

import yaml

from .creator import Creator, CreatorConfig
from .environment import profile_env
from .presentation import PresentationError, PresentationTools
from .start_session import SessionStarter, StartSessionConfig


def _artifact() -> dict[str, Any]:
    configured = profile_env("AOS_HERMES_PRESENTATION_PATH")
    path = Path(configured) if configured else Path(__file__).parent / "_generated" / "presentation.json"
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict) or not isinstance(value.get("tools"), list):
        raise ValueError("Invalid generated presentation artifact")
    return value


def _presentation_handler(tools: PresentationTools, name: str):
    def handle(args: dict[str, Any], **kwargs: Any) -> str:
        try:
            return tools.handle(name, args)
        except (PresentationError, TypeError, ValueError) as exc:
            return json.dumps({"ok": False, "error": str(exc)}, separators=(",", ":"), ensure_ascii=False)
    return handle


START_SCHEMA = {
    "name": "aos_start_session",
    "description": (
        "Start an independent durable Session in an explicit Hermes profile and worktree. "
        "The call runs natively even when no AOS browser is open."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "profile": {"type": "string", "pattern": "^[a-z][a-z0-9-]{1,31}$"},
            "workdir": {"type": "string", "minLength": 1},
            "prompt": {"type": "string", "minLength": 1},
            "title": {"type": "string", "minLength": 1, "maxLength": 72},
        },
        "required": ["profile", "workdir", "prompt"],
        "additionalProperties": False,
    },
}

CREATOR_SCHEMA = {
    "name": "aos_create_agent",
    "description": (
        "Validate a confirmed Hermes Agent proposal. Automated creation is unavailable "
        "at the supported native revision until Hermes provides atomic no-overwrite profile creation."
    ),
    "parameters": {
        "type": "object", "properties": {
            "profileName": {"type": "string", "pattern": "^[a-z][a-z0-9-]{1,31}$"},
            "description": {"type": "string", "minLength": 1, "maxLength": 300},
            "instructions": {"type": "string", "minLength": 1, "maxLength": 8000},
            "allowedCapabilities": {
                "type": "array", "minItems": 1, "uniqueItems": True,
                "items": {"type": "string", "enum": [
                    "structured-presentations", "session-handoff",
                ]},
            },
            "confirmed": {"type": "boolean", "const": True},
        }, "required": ["profileName", "description", "instructions", "allowedCapabilities", "confirmed"],
        "additionalProperties": False,
    },
}


def _native_home() -> Path | None:
    try:
        from hermes_constants import get_hermes_home
        return Path(get_hermes_home())
    except (ImportError, OSError, TypeError, ValueError):
        return None


def _is_explicit_creator() -> bool:
    home = _native_home()
    if home is None:
        return False
    try:
        value = yaml.safe_load((home / "profile.yaml").read_text(encoding="utf-8"))
    except (OSError, yaml.YAMLError):
        return False
    if not isinstance(value, dict):
        return False
    ui_meta = value.get("ui_meta")
    if not isinstance(ui_meta, dict):
        return False
    aos = ui_meta.get("aos")
    bots = ui_meta.get("hermes-bots")
    return (
        isinstance(aos, dict)
        and aos.get("role") == "creator"
        and isinstance(bots, dict)
        and bots.get("hidden") is True
    )


def register(ctx: Any) -> None:
    artifact = _artifact()
    configured = profile_env("AOS_HERMES_PRESENTATION_PATH")
    artifact_path = Path(configured) if configured else Path(__file__).parent / "_generated" / "presentation.json"
    tools = PresentationTools(artifact_path)
    for schema in artifact["tools"]:
        ctx.register_tool(
            name=schema["name"], toolset="aos-presentation", schema=schema,
            handler=_presentation_handler(tools, schema["name"]),
        )

    starter = SessionStarter(StartSessionConfig(
        hermes_executable=profile_env("AOS_HERMES_EXECUTABLE", "hermes") or "hermes",
    ))

    def start_session(args: dict[str, Any], **kwargs: Any) -> str:
        try:
            return json.dumps(starter.start(
                str(args.get("profile") or ""),
                str(args.get("workdir") or ""),
                str(args.get("prompt") or ""),
                title=str(args["title"]) if args.get("title") is not None else None,
            ), separators=(",", ":"), ensure_ascii=False)
        except ValueError as exc:
            return json.dumps({"ok": False, "status": "rejected", "error": str(exc)}, separators=(",", ":"))

    ctx.register_tool(
        name=START_SCHEMA["name"], toolset="aos-session-handoff",
        schema=START_SCHEMA, handler=start_session,
    )
    ctx.register_system_prompt_section(
        "aos.presentation", str(artifact.get("instructions") or "")[:4000],
        position="after_memory", max_chars=4000,
    )

    # Creator authority is operator-provisioned native metadata, not an env
    # switch and never a self-write by this plugin.
    if not _is_explicit_creator():
        return
    plugin_source = profile_env("AOS_HERMES_PLUGIN_SOURCE") or ""
    plugin_ref = profile_env("AOS_HERMES_PLUGIN_REF") or ""
    creator = (
        Creator(CreatorConfig(
            hermes_executable=profile_env("AOS_HERMES_EXECUTABLE", "hermes") or "hermes",
            plugin_source=plugin_source,
            plugin_ref=plugin_ref,
        ))
        if plugin_source and re.fullmatch(r"[0-9a-f]{40}", plugin_ref)
        else None
    )

    def create_agent(args: dict[str, Any], **kwargs: Any) -> str:
        if args.get("confirmed") is not True:
            return json.dumps({
                "ok": False,
                "status": "failed",
                "error": "Explicit confirmation is required",
            })
        if creator is None:
            return json.dumps({
                "ok": False,
                "status": "setup-needed",
                "error": "Creator setup requires an immutable Hermes plugin source and full commit ref",
            }, separators=(",", ":"))
        try:
            return json.dumps({"ok": True, **creator.create(
                str(args.get("profileName") or ""),
                str(args.get("description") or ""),
                str(args.get("instructions") or ""),
                list(args.get("allowedCapabilities") or []),
            )}, separators=(",", ":"), ensure_ascii=False)
        except (ValueError, RuntimeError) as exc:
            return json.dumps({
                "ok": False,
                "status": "failed",
                "error": str(exc),
            }, separators=(",", ":"))

    ctx.register_tool(
        name=CREATOR_SCHEMA["name"], toolset="aos",
        schema=CREATOR_SCHEMA, handler=create_agent,
    )
    guidance = Path(__file__).parent / "_generated" / "agent-creator.md"
    if guidance.exists():
        ctx.register_system_prompt_section(
            "aos.agent_creator", guidance.read_text(encoding="utf-8")[:4000],
            position="after_memory", max_chars=4000,
        )
