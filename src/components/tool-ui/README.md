# Tool UI

Rich-tool renderers for the AOS workspace. Every surface turns a provider
tool-call result into a safe, localized, theme-aware UI component.

## Surface pattern

Each surface lives in its own directory and follows the same layout:

| File            | Role                                                      |
| --------------- | --------------------------------------------------------- |
| `_adapter.tsx`  | Converts raw provider args/result to the surface's schema |
| `index.tsx`     | Public React export (re-exports the component)            |
| `schema.ts`     | Zod schema + TypeScript types for the payload             |
| `<surface>.tsx` | The React component                                       |

## Registry

`registry.tsx` is the dispatch table. It maps tool names to renderers via
`defineToolRenderer`, which validates the payload before rendering. Optional
surfaces (`optional: true`) wrap their output in `OptionalToolDisplay` so a
load failure leaves an inspectable textual fallback instead of a blank area.

**Eager renderers** (Todos) are imported directly because the default workspace
always uses them. **Lazy renderers** (question-flow, chart, geo-map, stats,
permission) are imported with `React.lazy` to keep the main bundle lean.

## Tool names each surface answers

| Registry key(s)                 | Surface       |
| ------------------------------- | ------------- |
| `render_chart`                  | chart         |
| `render_map`                    | geo-map       |
| `render_stats`                  | stats-display |
| `ask_user_question`, `question` | question-flow |
| `request_permission`            | permission    |
| `delegate_subagent`, `task`     | activity      |

## Tool artifact views

`tool-artifact.ts` is the browser contract for what a tool call carries beyond
its args and result: `ToolCallMessagePart.artifact` holds `{ aos:
AosToolArtifact }` with the ACP tool kind, locations, diffs, terminals,
subagent metadata, and the state of an MCP App view the tool declares (`app`,
read by `src/components/mcp-apps/tool-part.ts`). Read it with
`readAosToolArtifact` and extend it with `withAosToolArtifact`.

`LazyToolDiff` (`code-diff`, Pierre diffs) and `LazyToolTerminal` (`terminal`,
ANSI output) render that data on demand. They are not registry-dispatched by
tool name; the caller passes the data and the `labels` from
`useToolDiffLabels()` / `useToolTerminalLabels()`. A load failure leaves the
changes list and raw patch, or the ANSI-stripped output, as plain text.

The `render_*` tools come from the AOS UI tools MCP server
(`packages/tools-mcp`). Each harness prefixes MCP tool names differently
(`mcp__aos_ui__render_chart` on Hermes, `aos-ui__render_chart` on OpenClaw);
the proxy canonicalizes them in `packages/proxy/core/aos-tool-names.ts`, so
the registry only ever sees the bare names above. The fourth server tool,
`present_artifact`, publishes an Artifact and is resolved by
`src/components/artifacts`, not by this registry.

## Safety rule

Rich output must stay inspectable and safe:

- Every surface has a textual fallback. A missing or failed renderer leaves
  the raw JSON visible via `GenericJsonTool`, never a blank gap.
- Never execute generated browser code or arbitrary HTML in this layer. Mermaid
  diagrams, charts, and maps render through sandboxed or pure-JS engines.
- Optional surfaces resolve lazily; a broken bundle leaves the tool inspectable.

## Testing

```bash
bun run test src/components/tool-ui
```
