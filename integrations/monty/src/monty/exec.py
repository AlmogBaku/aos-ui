import inspect
import textwrap
from typing import Any, Callable

import sys

from pydantic_monty import AsyncMonty
from mcp import ClientSession
from mcp.types import Tool

from monty.codegen import mcp_tool_typing
from monty.mcp_tool import tool_properties
from monty.builtins import Builtin, default_builtins


def _mcp_tool_to_type_definition(tool: Tool) -> str:
    typing = mcp_tool_typing(tool)
    stub = textwrap.dedent(f"""
    {typing.signature}:
        raise NotImplementedError()
    """)
    if typing.helper_code:
        return f"{typing.helper_code}\n\n{stub}"
    return stub


def mcp_tool_to_python_function(tool: Tool, session: ClientSession) -> Callable[..., Any]:
    """Build an async Python callable from an MCP Tool that calls session.call_tool."""
    typing = mcp_tool_typing(tool)
    props = tool_properties(tool)
    param_names = sorted(props.keys())
    required = set(tool.inputSchema.get("required", [])) if isinstance(tool.inputSchema, dict) else set()

    async def _call_tool(*args: Any, **kwargs: Any) -> Any:
        if typing.payload_param:
            payload = kwargs.get("payload", args[0] if args else None)
            if hasattr(payload, "model_dump"):
                arguments = payload.model_dump(exclude_none=True)  # type: ignore[union-attr]
            elif isinstance(payload, dict):
                arguments = payload
            elif payload is None:
                arguments = {}
            else:
                arguments = dict(payload)
        else:
            arguments = dict(zip(param_names, args)) | kwargs
        result = await session.call_tool(tool.name, arguments=arguments)
        if result.structuredContent is not None:
            content = result.structuredContent
            # Unwrap single "result" key from FastMCP-style tool response
            if content.keys() == {"result"}:
                return content["result"]
            return content
        for block in result.content:
            if getattr(block, "type", None) == "text":
                text = getattr(block, "text", None)
                if text is not None:
                    return text
        return result

    _call_tool.__name__ = tool.name
    if typing.payload_param:
        _call_tool.__signature__ = inspect.Signature(  # type: ignore[attr-defined]
            parameters=[inspect.Parameter(name="payload", kind=inspect.Parameter.KEYWORD_ONLY)]
        )
    else:
        _call_tool.__signature__ = inspect.Signature(  # type: ignore[attr-defined]
            parameters=[
                inspect.Parameter(
                    name=key,
                    kind=inspect.Parameter.KEYWORD_ONLY,
                    default=None if key not in required else inspect.Parameter.empty,
                )
                for key in param_names
            ]
        )
    return _call_tool


class Executor:
    """Upstream MCP executor adapted to Monty's current session API."""

    def __init__(
        self, tools: list[Tool], session: ClientSession | None = None, builtins: tuple[Builtin, ...] | None = None
    ):
        self.builtins = default_builtins() if builtins is None else builtins

        def async_builtin(function: Callable[..., Any]) -> Callable[..., Any]:
            async def call(*args: Any, **kwargs: Any) -> Any:
                return function(*args, **kwargs)

            return call

        self.external_functions = {tool.name: async_builtin(tool.function) for tool in self.builtins}
        definitions = [f"{tool.signature}: ..." for tool in self.builtins]
        for tool in tools:
            if tool.name in self.external_functions:
                raise ValueError(f"Duplicate tool name: {tool.name}")
            if session is None:
                raise ValueError("Downstream tools require an MCP session")
            self.external_functions[tool.name] = mcp_tool_to_python_function(tool, session)
            definitions.append(_mcp_tool_to_type_definition(tool))
        self.type_stubs = "\n\n".join(definitions)

    async def execute(self, code: str) -> Any:
        async with AsyncMonty() as pool:
            async with pool.checkout(type_check=True, type_check_stubs=self.type_stubs) as session:
                return await session.feed_run(
                    textwrap.dedent(code).strip(),
                    external_lookup=self.external_functions,
                    # stdout belongs to MCP framing; ordinary print output is diagnostic.
                    print_callback=lambda _stream, text: sys.stderr.write(text),
                )
