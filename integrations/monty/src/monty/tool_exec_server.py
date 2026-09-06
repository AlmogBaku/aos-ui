"""Upstream stdio MCP server with builtins and adaptive tool discovery."""

import argparse
from contextlib import AsyncExitStack, asynccontextmanager
from pathlib import Path
from typing import Any

from mcp import StdioServerParameters
from mcp.server.fastmcp import Context, FastMCP

from monty.builtins import default_builtins
from monty.codegen import mcp_tool_signature
from monty.exec import Executor
from monty.mcp_client import load_backend_params, mcp_stdio_session
from monty.search import ToolSearchIndex


def create_tool_exec_server(
    backend_params: StdioServerParameters | None = None, *, embedding_threshold: int = 30
) -> FastMCP:
    @asynccontextmanager
    async def session_lifespan(server: FastMCP):
        async with AsyncExitStack() as stack:
            session = None
            tools = []
            if backend_params is not None:
                session = await stack.enter_async_context(mcp_stdio_session(backend_params))
                result = await session.list_tools()
                tools = list(result.tools)
                while result.nextCursor:
                    result = await session.list_tools(cursor=result.nextCursor)
                    tools.extend(result.tools)
            builtins = default_builtins()
            executor = Executor(tools, session, builtins)
            entries = [tool.metadata() for tool in builtins] + [
                {"name": tool.name, "signature": mcp_tool_signature(tool), "description": tool.description or ""}
                for tool in tools
            ]
            index = await ToolSearchIndex.create(entries, embedding_threshold=embedding_threshold)
            stack.callback(index.close)
            description = (
                "Execute Python with the available functions. The final expression is returned. "
                "Use await to call tools. Use Python dictionaries for TypedDict payloads. "
                "Use search to discover available functions."
            )
            if not index.uses_embeddings:
                description += "\n\nAvailable functions:\n" + "\n".join(
                    f"{entry['signature']} — {entry['description']}" for entry in entries
                )

            @server.tool(description=description)
            async def execute(code: str, ctx: Context) -> Any:
                executor = ctx.request_context.lifespan_context["executor"]
                return await executor.execute(code)

            @server.tool(
                description="Search available functions by name or description; returns names, Python signatures, and descriptions."
            )
            async def search(query: str, ctx: Context, limit: int = 10) -> list[dict]:
                index = ctx.request_context.lifespan_context["search_index"]
                return index.search(query, limit)

            yield {"executor": executor, "search_index": index}

    return FastMCP(
        name="monty", instructions="Execute MCP tools and Python builtins in code.", lifespan=session_lifespan
    )


def main() -> None:
    parser = argparse.ArgumentParser(prog="python -m monty", description="Execute MCP tools in Python with Monty")
    parser.add_argument("--config", type=Path, help="Downstream MCP stdio server JSON (command and args)")
    parser.add_argument(
        "--embedding-threshold", type=int, default=30, help="Use embeddings above this tool count (default: 30)"
    )
    args = parser.parse_args()
    if args.embedding_threshold < 0:
        parser.error("--embedding-threshold must be non-negative")
    params = load_backend_params(args.config) if args.config else None
    create_tool_exec_server(params, embedding_threshold=args.embedding_threshold).run(transport="stdio")


if __name__ == "__main__":
    main()
