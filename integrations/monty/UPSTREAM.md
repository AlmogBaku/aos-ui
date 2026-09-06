# Upstream provenance

Forked from https://github.com/DevonFulcher/monty-mcp at commit
`21a905851e9eb1aa408e18e6a0cf1df7724d5dcf` (2026-03-14).

MIT licensed, Copyright (c) 2026 Devon Fulcher. See `LICENSE`.

The fork is named `monty`. It retains downstream MCP stdio connections,
automatic schema generation, and direct execution results. Changes are:

- Math, random, and standard-library helpers alongside downstream tools.
- Catalog-size-based lexical or upstream hybrid search, with optional semantic
  dependencies and full signature discovery for small catalogs.
- A compatibility adapter for pydantic-monty 0.0.21's session API.
- Generated `TypedDict` payloads in place of Pydantic constructors, so complex
  schemas can be passed as dictionaries inside Monty. Discovery includes these
  definitions. Builtin wrappers accept their advertised keyword arguments.

`codegen.py`, `mcp_tool.py`, and `mcp_client.py` originate from upstream.
`exec.py`, `semantic.py`, and `tool_exec_server.py` retain upstream mechanisms
with the adaptations above. Upstream schema and client regression tests are
included in `tests`.
