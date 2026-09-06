import contextlib
import json
from pathlib import Path

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client


def load_backend_params(path: Path) -> StdioServerParameters:
    """Load command and args from a JSON config file into StdioServerParameters."""
    try:
        raw = path.read_text()
    except FileNotFoundError as e:
        raise SystemExit(f"Config file not found: {path}") from e
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as e:
        raise SystemExit(f"Invalid JSON in {path}: {e}") from e
    command = data.get("command", "uv")
    if not isinstance(command, str) or not command.strip():
        raise SystemExit(f"Invalid 'command' in {path}: expected a non-empty string")

    cmd_args = data.get("args")
    if cmd_args is None:
        raise SystemExit(f"Missing 'args' in {path}")
    if not isinstance(cmd_args, list) or not all(isinstance(arg, str) for arg in cmd_args):
        raise SystemExit(f"Invalid 'args' in {path}: expected a list of strings")

    return StdioServerParameters(command=command, args=cmd_args)


@contextlib.asynccontextmanager
async def mcp_stdio_session(params: StdioServerParameters):
    async with stdio_client(params) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            yield session
