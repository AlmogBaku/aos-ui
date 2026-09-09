# Assistant UI `ComposerContext` data availability

Status: implementation research. Assistant UI is pinned to upstream commit
[`0bea0fc`](https://github.com/assistant-ui/assistant-ui/tree/0bea0fc504a169ccb699c4c9efd2d7a29651c186),
OpenCode observations to [`9f8db11`](https://github.com/anomalyco/opencode/tree/9f8db119fcbd4999379129ac7734375ac23460fb),
and the local Hermes Dashboard checkout to
[`b29b352`](https://github.com/AlmogBaku/hermes-agent/tree/b29b352c9eeec261fc17b09bd5402b5a8a0c4a8b).

## Conclusion

Yes, both native runtimes can feed the official Assistant UI Elements
`ComposerContext`. The component is a copied, props-driven visual component;
it does not discover or calculate context data itself.

- Hermes has the best native fit: `session.context_breakdown` already returns
  a model limit, overall occupancy and a detailed category breakdown. Its
  categories are estimates even when overall occupancy is provider-measured.
- OpenCode exposes provider-measured turn usage plus the configured model
  context limit. Its own app estimates the category split client-side from
  message content; OpenCode has no native category-breakdown endpoint.
- Consequently, the ring can be based on native provider usage in both
  runtimes. AOS shows category rows only when the runtime returns category
  data; it does not render absent OpenCode categories as zero or present its
  client-side approximation as native data. The element has no `estimated`
  prop or `~` treatment.

No new server or shared runtime capability is required. Keep the provider data
collection and mapping inside the existing Hermes/OpenCode adapters and pass
the resulting four-number view model into the shared component.

## Exact Assistant UI contract

`ComposerContext` is installed with
`npx shadcn@latest add "@assistant-ui/elements-composer"` and copied into the
application; it is not an export of `@assistant-ui/react`. Its exact input is:

```ts
type ComposerUsage = {
  system: number
  tools: number
  messages: number
  total: number
}

type ComposerContextProps =
  Omit<React.ComponentProps<"div">, "children"> & {
    usage: ComposerUsage
  }
```

All four values are **thousands of tokens**. The element computes
`used = system + tools + messages`, fills the ring against `total`, clamps the
arc to 0–100%, and switches to warning styling above 85%. Its hover/focus panel
has three fixed categories and no controlled `open` prop. The caller owns every
number.

Assistant UI runtime state does not provide the category split or model context
window. The documented runtime example sums each message step's optional
`usage.inputTokens + usage.outputTokens`, then supplies system/tools estimates
and the model limit separately. Missing step usage contributes zero.

Sources:

- [Element documentation and runtime example](https://www.assistant-ui.com/elements/composer-context)
- [Documentation source](https://github.com/assistant-ui/assistant-ui/blob/0bea0fc504a169ccb699c4c9efd2d7a29651c186/apps/docs/content/elements/composer-context.mdx#L6-L74)
- [`ComposerUsage` and props](https://github.com/assistant-ui/assistant-ui/blob/0bea0fc504a169ccb699c4c9efd2d7a29651c186/packages/ui/src/components/react/assistant-ui/elements/composer.tsx#L57-L62)
- [Rendering and ring calculation](https://github.com/assistant-ui/assistant-ui/blob/0bea0fc504a169ccb699c4c9efd2d7a29651c186/packages/ui/src/components/react/assistant-ui/elements/composer.tsx#L479-L592)

## Hermes Dashboard API

The existing Dashboard WebSocket JSON-RPC method
`session.context_breakdown` returns:

```ts
interface ContextBreakdown {
  categories: Array<{ id: string; label: string; color: string; tokens: number }>
  context_max: number
  context_used: number
  context_percent: number
  context_estimated?: boolean
  context_source?: string
  estimated_total: number
  model?: string
}
```

It requires only the existing `session_id`; no extra server is involved. The
Dashboard itself fetches it when the gauge is visible and refetches after a turn
finishes.

Suggested three-way aggregation before converting tokens to thousands:

| Assistant UI field | Hermes category IDs |
|---|---|
| `system` | `system_prompt`, `rules`, `skills`, `memory` |
| `tools` | `tool_definitions`, `mcp`, `subagent_definitions` |
| `messages` | `conversation` |
| `total` | `context_max` |

Provenance is mixed:

- The category counts and `estimated_total` are always local estimates. Hermes
  uses character/4 and JSON-size/4 approximations.
- `context_used` is exact only when `context_source === "provider_usage"`.
- `provider_usage_plus_estimate` is a provider-anchored measurement plus an
  estimated transcript delta; `local_estimate` is wholly estimated.
- `context_max` comes from the active agent's model/context-compressor metadata.

Because `ComposerContext` derives occupancy from the sum of its three
categories, raw Hermes categories make the ring represent `estimated_total`,
not necessarily `context_used`. If the product requires the ring to match the
native occupancy, scale the three aggregated category estimates proportionally
so their sum equals `context_used`. The category proportions remain estimates
either way.

Local first-party evidence:

- RPC and fallback shape:
  `/home/anakin/.hermes/hermes-agent/tui_gateway/methods_session.py:1145`
- Estimator, category definitions and provenance:
  `/home/anakin/.hermes/hermes-agent/agent/context_breakdown.py:1`
- Dashboard request lifecycle:
  `/home/anakin/.hermes/hermes-agent/apps/desktop/src/app/shell/hooks/use-context-breakdown.ts:18`
- Dashboard contract:
  `/home/anakin/.hermes/hermes-agent/apps/desktop/src/types/hermes.ts:799`

## OpenCode API and app behavior

OpenCode supplies the two authoritative inputs for overall occupancy:

1. An assistant message carries provider-normalized `tokens` (`input`,
   `output`, `reasoning`, cache read/write, and sometimes `total`). OpenCode's
   normalization starts from provider/AI SDK usage. Recombining the separated
   fields produces the provider's inclusive input-plus-output usage for that
   generation.
2. The provider/model catalog supplies `model.limit.context`.

The OpenCode app itself selects the latest assistant message with nonzero
usage, computes total usage from input/output/reasoning/cache values, and divides
that by `model.limit.context` for its ring. This is the appropriate native basis
for AOS's overall context ring.

OpenCode does **not** expose a server-side System/Tools/Messages token
breakdown. Its app labels its own breakdown as approximate and computes it in
the client:

- text and system-prompt characters are estimated at `ceil(chars / 4)`;
- tool calls use an approximation over input/output text and keys;
- the provider-reported input count is the anchor;
- unallocated provider input becomes `other`, and estimated categories are
  proportionally reduced if they exceed the input anchor.

If a product deliberately chooses OpenCode's approximate client calculation,
the closest three-category aggregation would be:

| Assistant UI field | OpenCode app categories |
|---|---|
| `system` | `system` |
| `tools` | `tool` + `other` |
| `messages` | `user` + `assistant` |
| `total` | selected model's `limit.context` |

`other` includes tool definitions and protocol overhead, so assigning it to
`tools` is only an approximation. AOS does not use this estimate: it renders
the authoritative total/ring and omits unavailable category rows.
The currently installed v2 SDK also exposes `session.context()`, which returns
active messages after the last compaction; it does not return token categories
and therefore does not remove the need for estimation.

Sources:

- [OpenCode overall context metric](https://github.com/anomalyco/opencode/blob/9f8db119fcbd4999379129ac7734375ac23460fb/packages/app/src/components/session/session-context-metrics.ts#L28-L61)
- [OpenCode client-side category estimator](https://github.com/anomalyco/opencode/blob/9f8db119fcbd4999379129ac7734375ac23460fb/packages/app/src/components/session/session-context-breakdown.ts#L1-L132)
- [OpenCode UI wiring and approximate breakdown input](https://github.com/anomalyco/opencode/blob/9f8db119fcbd4999379129ac7734375ac23460fb/packages/app/src/components/session/session-context-tab.tsx#L101-L175)
- [Provider usage normalization](https://github.com/anomalyco/opencode/blob/9f8db119fcbd4999379129ac7734375ac23460fb/packages/opencode/src/session/session.ts#L336-L386)
- Installed SDK context endpoint:
  `node_modules/@opencode-ai/sdk/dist/v2/gen/sdk.gen.d.ts:1714`
- Installed SDK model limit and message-token types:
  `node_modules/@opencode-ai/sdk/dist/v2/gen/types.gen.d.ts:4030` and
  `node_modules/@opencode-ai/sdk/dist/v2/gen/types.gen.d.ts:3371`

## Implementation boundary

The shared UI receives the Assistant UI-shaped values, already in thousands,
plus an optional list of categories the runtime actually supplied:

```ts
type ComposerContextUsage = {
  usage: { system: number; tools: number; messages: number; total: number }
  segments?: Array<"system" | "tools" | "messages">
}
```

Hermes/OpenCode response parsing, provenance handling and category aggregation
belong inside their current adapter modules. This preserves runtime decoupling
and does not add a `RuntimeBundle`, `WorkspaceAdapter`, model registry, tokenizer
or server.
