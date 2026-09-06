# Monty Fork Implementation Plan

**Goal:** Restore upstream Monty MCP behavior with builtins and adaptive search.

**Architecture:** Fork the pinned upstream modules into `integrations/monty/src/monty`.
Keep the current engine adapter, downstream stdio session lifecycle, and upstream
schema generation. Integrate builtins into the same discoverable catalog.

**Tech Stack:** Python, pydantic-monty 0.0.21, MCP, LanceDB, sentence-transformers.

**Spec:** `docs/superpowers/specs/2026-09-05-monty-fork-design.md`

## Tasks

- [x] Demonstrate the old executor violates the direct-result contract with a failing test.
- [x] Fork upstream source, restore downstream connections and generated types,
      remove the bespoke policy, and retain builtins without gating downstream tools.
- [x] Add adaptive search, lazy semantic imports, and full small-catalog discovery.
- [x] Test real stdio calls against a temporary downstream server, schema generation,
      collisions, plain results, and both search paths.
- [x] Rename packaging and OpenCode entry points to `monty`; synchronize the lockfile.
- [x] Update runtime/provenance documentation, remove the duplicate vendor tree,
      and remove obsolete policy tests.
- [x] Run Python tests, relevant OpenCode tests, and repository checks; review the diff.

## Verification

- Python: 20 passed with semantic dependencies; fresh lightweight install: 19 passed, 1 skipped.
- Real stdio downstream integration and real MiniLM semantic search passed.
- TypeScript: 366 passed, 2 skipped; updated OpenCode configuration tests passed.
- Typecheck, production build, lint, and diff whitespace checks passed.
- Browser fixtures: 29 passed initially; the remaining Hebrew visibility test passed on isolated retry. OpenCode (3) and AG-UI (1) browser tests passed.
- Review findings for nested schemas and builtin keyword arguments fixed and verified.
