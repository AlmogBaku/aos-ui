from mcp import Tool


def tool_properties(tool: Tool) -> dict:
    schema = tool.inputSchema or {}
    if not isinstance(schema, dict):
        return {}
    props = schema.get("properties")
    return props if isinstance(props, dict) else {}
