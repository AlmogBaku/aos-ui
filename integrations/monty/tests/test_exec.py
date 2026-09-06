"""Tests for generated tool stubs/signatures."""

from mcp.types import Tool

from monty.codegen import mcp_tool_typing
from monty.exec import _mcp_tool_to_type_definition as mcp_tool_to_type_definition


def test_mcp_tool_to_code_basic():
    """Generated code includes tool name, signature from inputSchema properties, and call_tool."""
    tool = Tool(
        name="search",
        inputSchema={"type": "object", "properties": {"query": {"type": "string"}}},
    )
    code = mcp_tool_to_type_definition(tool)
    assert code == """
async def search(query: str) -> dict:
    raise NotImplementedError()
"""


def test_mcp_tool_to_code_includes_output_schema():
    """When outputSchema is set, it appears in the return type."""
    tool = Tool(
        name="fetch",
        inputSchema={"type": "object", "properties": {"url": {"type": "string"}}},
        outputSchema={"type": "object", "properties": {"status": {"type": "integer"}}},
    )
    code = mcp_tool_to_type_definition(tool)
    assert code == """
async def fetch(url: str) -> int:
    raise NotImplementedError()
"""


def test_mcp_tool_to_code_empty_input_schema():
    """Tool with empty inputSchema produces no parameters."""
    tool = Tool(name="ping", inputSchema={})
    code = mcp_tool_to_type_definition(tool)
    assert code == """
async def ping() -> dict:
    raise NotImplementedError()
"""


def test_mcp_tool_to_code_non_object_schema_omits_params():
    """Non-object/ambiguous schema paths use generated payload models."""
    tool = Tool(name="echo", inputSchema={"message": {"type": "string"}})
    code = mcp_tool_to_type_definition(tool)
    assert "EchoInput: TypeAlias = Any" in code
    assert "async def echo(payload: EchoInput) -> dict:" in code


def test_mcp_tool_to_code_output_schema_none():
    """When outputSchema is None, return type is dict in generated code."""
    tool = Tool(
        name="noop",
        inputSchema={"type": "object"},
        outputSchema=None,
    )
    code = mcp_tool_to_type_definition(tool)
    assert code == """
async def noop() -> dict:
    raise NotImplementedError()
"""


def test_complex_schema_uses_payload_model_signature() -> None:
    """Complex schemas switch to payload model signatures."""
    tool = Tool(
        name="search",
        inputSchema={
            "type": "object",
            "properties": {
                "query": {
                    "oneOf": [{"type": "string"}, {"type": "integer"}],
                }
            },
            "required": ["query"],
        },
    )
    typing = mcp_tool_typing(tool)
    assert typing.payload_param is True
    assert typing.signature.startswith("async def search(payload: SearchInput)")
    assert "class SearchInput" in typing.helper_code
