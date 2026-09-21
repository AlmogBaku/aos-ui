from __future__ import annotations

import json
import logging
import re
from pathlib import Path
from typing import Any

import yaml

from .creator import CreationError, Creator, CreatorConfig, ValidationError
from .artifact import ArtifactPublisher
from .environment import profile_env
from .presentation import PresentationError, PresentationTools
from .start_session import SessionStarter, StartSessionConfig

logger = logging.getLogger(__name__)


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
        "Create a confirmed Hermes Agent profile. The profile stays hidden until its package "
        "and toolsets are enabled; an incomplete setup is reported for an operator to finish."
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

ARTIFACT_SCHEMA = {
    "name": "present_artifact",
    "description": (
        "Publish an existing file from this Session's workdir as an explicit AOS artifact. "
        "Returns a reference receipt; it does not place file contents in model context."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "path": {"type": "string", "minLength": 1},
            "title": {"type": "string", "minLength": 1, "maxLength": 255},
            "mimeType": {"type": "string", "minLength": 1, "maxLength": 255},
        },
        "required": ["path"],
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
    publisher = ArtifactPublisher()

    def present_artifact(args: dict[str, Any], **kwargs: Any) -> str:
        try:
            return json.dumps(publisher.publish(
                str(args.get("path") or ""),
                task_id=kwargs.get("task_id"),
                session_id=kwargs.get("session_id"),
                title=str(args["title"]) if args.get("title") is not None else None,
                mime_type=str(args["mimeType"]) if args.get("mimeType") is not None else None,
            ), separators=(",", ":"), ensure_ascii=False)
        except (TypeError, ValueError) as exc:
            return json.dumps({
                "ok": False,
                "status": "rejected",
                "error": str(exc),
            }, separators=(",", ":"), ensure_ascii=False)

    ctx.register_tool(
        name=ARTIFACT_SCHEMA["name"], toolset="aos-presentation",
        schema=ARTIFACT_SCHEMA, handler=present_artifact,
    )
    ctx.register_system_prompt_section(
        "aos.presentation", str(artifact.get("instructions") or "")[:4000],
        position="after_memory", max_chars=4000,
    )
    invite_guidance = Path(__file__).parent / "_generated" / "invite-link.md"
    ctx.register_skill(
        name="aos-invite-link",
        path=invite_guidance,
        description="Create a signed AOS guest invitation for an explicit Hermes profile.",
    )
    ctx.register_system_prompt_section(
        "aos.invite_link",
        "When the user asks for an AOS guest invite, load "
        "`aos-integration:aos-invite-link` with `skill_view` and follow it.",
        position="after_memory", max_chars=300,
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
                "error": (
                    "Creator setup requires AOS_HERMES_PLUGIN_SOURCE "
                    "and a full-commit AOS_HERMES_PLUGIN_REF"
                ),
            }, separators=(",", ":"))
        try:
            result = creator.create(
                str(args.get("profileName") or ""),
                str(args.get("description") or ""),
                str(args.get("instructions") or ""),
                list(args.get("allowedCapabilities") or []),
            )
        except (ValidationError, CreationError) as exc:
            return json.dumps({
                "ok": False,
                "status": "failed",
                "error": str(exc),
            }, separators=(",", ":"))
        except Exception:
            logger.exception("Hermes Agent creation failed")
            return json.dumps({
                "ok": False,
                "status": "failed",
                "error": "Profile creation failed",
            }, separators=(",", ":"))
        return json.dumps(
            {"ok": result.get("status") == "ready", **result},
            separators=(",", ":"), ensure_ascii=False,
        )

    ctx.register_tool(
        name=CREATOR_SCHEMA["name"], toolset="aos",
        schema=CREATOR_SCHEMA, handler=create_agent,
    )
    guidance = Path(__file__).parent / "_generated" / "agent-creator.md"
    if guidance.exists():
        # The interview is a skill the creator loads from its own file, like any
        # other, rather than a copy of that file pasted into every prompt.
        ctx.register_skill(
            name="aos-agent-creator",
            path=guidance,
            description=(
                "Interview the user and create a native Agent once they confirm "
                "its purpose, instructions, and allowed capabilities."
            ),
        )
        ctx.register_system_prompt_section(
            "aos.agent_creator",
            "When the user asks for a new Agent, load "
            "`aos-integration:aos-agent-creator` with `skill_view` and follow it.",
            position="after_memory", max_chars=300,
        )
