"""Generated dictionary types preserve MCP payload validation."""

import pytest
from mcp.types import Tool
from pydantic import TypeAdapter, ValidationError

from monty.codegen import mcp_tool_signature, mcp_tool_typing


def test_generated_types_preserve_required_optional_and_union_fields():
    tool = Tool(
        name="search",
        inputSchema={
            "type": "object",
            "properties": {
                "query": {"anyOf": [{"type": "string"}, {"type": "integer"}]},
                "limit": {"anyOf": [{"type": "integer"}, {"type": "null"}], "default": None},
            },
            "required": ["query"],
        },
    )
    typing = mcp_tool_typing(tool)
    namespace = {}
    exec(typing.helper_code, namespace, namespace)
    adapter = TypeAdapter(namespace["SearchInput"])
    assert adapter.validate_python({"query": "hello"}) == {"query": "hello"}
    assert adapter.validate_python({"query": 42, "limit": None}) == {"query": 42, "limit": None}
    with pytest.raises(ValidationError):
        adapter.validate_python({})
    with pytest.raises(ValidationError):
        adapter.validate_python({"query": []})
    # Discovery supplies the definitions needed to form the dictionary payload.
    assert "query:" in mcp_tool_signature(tool)
    assert "limit:" in mcp_tool_signature(tool)
