# Monty

A fork of Monty MCP that runs Python with tools from a downstream MCP server.
It keeps upstream's `execute(code)` and `search(query)` interface, automatic
schema-to-Python generation, and direct execution results. It adds builtins
and chooses search based on catalog size.

The package, Python module, and MCP server are named `monty`. Run it as
`python -m monty`: the engine already owns the native `monty` executable.
[UPSTREAM.md](./UPSTREAM.md) records the original commit and adaptations;
[LICENSE](./LICENSE) preserves upstream's MIT license.

## Run

With just the bundled helpers:

```sh
uv sync --project integrations/monty --frozen
uv run --project integrations/monty --frozen python -m monty
```

To also expose a downstream MCP server, create a JSON file with its command
and arguments, using the same format as upstream:

```json
{
  "command": "uvx",
  "args": ["your-mcp-server"]
}
```

```sh
uv run --project integrations/monty --frozen python -m monty --config /path/to/backend.json
```

Monty discovers the downstream tools, generates their Python signatures and
type stubs, and makes them callable alongside the builtins. Use `await` for
tool calls. Complex schemas use generated `TypedDict` definitions: pass ordinary
dictionaries as `payload`, using the fields shown by discovery. The last
expression is the result; there is no custom `value`,
`backendCalls`, or `truncated` envelope. `print()` goes to diagnostic stderr
so it does not interfere with the stdio MCP transport.

The fork uses the session API in `pydantic-monty==0.0.21`. It does not impose
the previous wrapper's source-length, call-count, output, or resource limits.
Python itself has no direct host filesystem or network access, but configured
MCP tools can perform the operations their server implements, including writes.
Tool names must be unique across the downstream server and builtins.

## Adaptive discovery

The tool count includes downstream tools and builtins.

- **At most 30 tools:** lexical/fuzzy search, with every function's signature
  and description included in `execute`'s description. No embedding model is
  imported or downloaded. The agent can use known functions without searching.
- **More than 30 tools:** upstream's keyword + semantic search. An embedding
  model is loaded once at startup and cached locally for subsequent starts.

Set `--embedding-threshold N` to change the cutoff; `0` uses embeddings for
any nonempty catalog. The catalog and descriptions stay fixed for the connection.
`search` also accepts an optional `limit`, defaulting to 10.

Install and run the semantic extra for large catalogs:

```sh
uv run --project integrations/monty --extra semantic --frozen python -m monty --config /path/to/backend.json
```

This installs LanceDB and sentence-transformers. The model downloads only when
catalog size requires embeddings. If the extra is missing for a large catalog,
startup reports the installation command rather than silently weakening search.
The default Alpine container supports the lightweight path; the semantic extra
requires a platform supported by PyTorch (for example, macOS or glibc Linux).

## Builtins

Monty 0.0.21 supports `json`, `math`, `datetime`, `re`, `collections`,
`itertools`, `dataclasses`, `typing`, and `unicodedata` inside Python.
The additional discoverable functions are:

- `math_add`, `math_subtract`, `math_multiply`, `math_divide`, `math_power`, `math_sqrt`
- `random_integer`, `random_float`, `random_choice` (optional seed; non-cryptographic)
- `stdlib_functools_reduce` (add, multiply, min, max)
- `stdlib_base64_b64encode`, `stdlib_base64_b64decode` (UTF-8 text)
- `stdlib_binascii_hexlify`, `stdlib_binascii_unhexlify` (UTF-8 text)

## OpenCode

`opencode.json` runs the local `python -m monty` module. OpenCode exposes the tools as
`monty_execute` and `monty_search`. To configure a downstream server, append
`--config` and the JSON file path after `monty` in its command array. For a large
catalog, insert `--extra`, `semantic` before `python` as in the command above.

## Tests

```sh
bun run monty:test
uv run --project integrations/monty --extra semantic --frozen pytest -q integrations/monty/tests
```

The second command also exercises the real LanceDB retrieval path using
controlled embeddings, without a model download. Tests launch real stdio
servers to verify downstream discovery, schema generation, builtin composition,
and execution results.
