# Monty upstream fork

Replace the independent AOS wrapper with a local fork of the pinned source
originally in `vendor/monty-mcp`. Remove the duplicate vendored tree as requested;
preserve its MIT license and commit attribution in the fork.
Name the Python package, module, and MCP server `monty`; launch with
`python -m monty` because the engine already owns the `monty` executable.

Restore upstream stdio downstream connections (`--config`), schema generation,
and direct execution results. With no downstream configured, builtins remain
available. Keep the adapter required by pydantic-monty 0.0.21, but remove the
custom execution-budget policy and response envelope.

Two additions:

1. Include the existing math, random, and standard-library helpers alongside
   downstream tools. Reject duplicate names rather than shadowing a tool.
2. Choose search when discovering the catalog: at most 30 tools uses lexical
   matching and advertises every signature in the execute description; larger
   catalogs use upstream hybrid keyword/vector search. `--embedding-threshold`
   configures the boundary. Load the embedding model only for a large catalog.
   Semantic packages are an optional extra; a large catalog requires that extra
   and reports an installation error if it is absent.

Verification covers actual stdio downstream discovery and execution, generated
schemas, combined builtins/downstream calls, direct results, discovery on both
sides of the threshold, and OpenCode configuration. Existing frontend rendering
already accepts arbitrary results and needs no change.
