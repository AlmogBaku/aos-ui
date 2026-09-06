import json
import os
import sys
from contextlib import asynccontextmanager
from pathlib import Path

import pytest
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client


@asynccontextmanager
async def monty_session(*args: str):
    params = StdioServerParameters(
        command=sys.executable,
        args=["-m", "monty", *args],
        env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"},
    )
    async with stdio_client(params) as (read, write):
        async with ClientSession(read, write) as session:
            initialized = await session.initialize()
            yield session, initialized


def value(result):
    assert not result.isError, result
    return json.loads(result.content[0].text)


@pytest.mark.asyncio
async def test_small_catalog_advertises_every_builtin_and_returns_plain_results():
    async with monty_session() as (session, initialized):
        assert initialized.serverInfo.name == "monty"
        listed = await session.list_tools()
        assert {t.name for t in listed.tools} == {"execute", "search"}
        execute = next(t for t in listed.tools if t.name == "execute")
        for name in ("math_add", "random_choice", "stdlib_binascii_unhexlify"):
            assert name in execute.description
        assert value(await session.call_tool("execute", {"code": "6 * 7"})) == 42
        assert value(await session.call_tool("execute", {"code": 'print("diagnostic")\n{"answer": 42}'})) == {
            "answer": 42
        }
        # No application-imposed source, call-count, or result envelope policy.
        code = "#" + "x" * 20001 + "\nvalues = [await math_add(1, 1) for _ in range(51)]\nsum(values)"
        assert value(await session.call_tool("execute", {"code": code})) == 102


@pytest.mark.asyncio
async def test_downstream_schema_discovery_and_builtin_composition(tmp_path: Path):
    backend = tmp_path / "backend.py"
    backend.write_text('''from mcp.server.fastmcp import FastMCP
from pydantic import BaseModel
server = FastMCP("test-backend")
class Customer(BaseModel):
    name: str
    email: str | None = None
@server.tool()
def customer_name(customer: Customer) -> str:
    return customer.name
@server.tool()
def customer_total(customer_id: str, multiplier: int) -> int:
    """Compute the customer's invoice total."""
    assert customer_id == "alice"
    return 21 * multiplier
@server.tool()
def fail() -> str:
    raise ValueError("downstream failed")
@server.tool()
def lookup(query: str | None = None) -> str:
    return query or "all customers"
server.run(transport="stdio")
''')
    config = tmp_path / "backend.json"
    config.write_text(json.dumps({"command": sys.executable, "args": [str(backend)]}))
    async with monty_session("--config", str(config)) as (session, _):
        searched = await session.call_tool("search", {"query": "customer invoice"})
        entries = searched.structuredContent["result"]
        assert entries[0]["name"] == "customer_total"
        assert "customer_id: str" in entries[0]["signature"]
        assert "multiplier: int" in entries[0]["signature"]
        code = 'total = await customer_total(customer_id="alice", multiplier=2)\nawait math_add(total, 8)'
        assert value(await session.call_tool("execute", {"code": code})) == 50
        result = await session.call_tool("execute", {"code": 'await lookup(payload={"query": "alice"})'})
        assert not result.isError, result
        assert result.content[0].text == "alice"
        result = await session.call_tool("execute", {"code": "await lookup(payload={})"})
        assert not result.isError, result
        assert result.content[0].text == "all customers"
        result = await session.call_tool(
            "execute", {"code": 'await customer_name(payload={"customer": {"name": "alice"}})'}
        )
        assert not result.isError, result
        assert result.content[0].text == "alice"


@pytest.mark.asyncio
async def test_builtin_random_defaults_and_encoding():
    async with monty_session() as (session, _):
        code = 'encoded = await stdlib_base64_b64encode("hello")\nawait stdlib_base64_b64decode(encoded)'
        result = await session.call_tool("execute", {"code": code})
        assert not result.isError
        assert result.content[0].text == "hello"
        result = await session.call_tool("execute", {"code": "await random_integer(1, 1)"})
        assert value(result) == 1
