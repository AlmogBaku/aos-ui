# Agent visibility and creator identity

The selected runtime is the only authority for Agent discovery and metadata.
AOS keeps no Agent registry and writes no operational metadata to browser
storage or an AOS service.

`WorkspaceAdapter.listAgents()` includes hidden Agents so AOS can resolve
Session ownership. The ordinary roster filters hidden Agents and Agents with
`role: "creator"`. The optional management catalog contains ordinary primary
Agents only; creators, native/system Agents, and Subagents are excluded.

Exactly one native Agent with `role: "creator"` enables `New Agent`. No creator
disables creation, while multiple creators surface a configuration error.
Fixture mode intentionally has no creator.

## Native metadata

OpenCode supplies discovery through `app.agents()`. Its `hidden` field controls
visibility, and `options.aos_ui_role: creator` identifies the creator. AOS reads
these fields directly. OpenCode metadata management is read-only because the
native API does not currently expose the required safe mutation; there is no
sidecar management server or filesystem writer in the browser.

Hermes supplies discovery through `profiles.list` and `profiles.describe`.
`ui_meta["hermes-bots"].hidden` controls visibility and
`ui_meta.aos.role: creator` identifies the creator. Visibility changes use the
native `profiles.configure` operation with the provider's metadata revision and
preserve unrelated fields. Revision conflicts fail visibly and are refreshed
from native state.

Generic AG-UI hosts may return `visibility`, `role`, `selectable`, and
`editable` metadata. Missing visibility means visible; absent mutation support
means read-only. When explicitly supported, visibility updates go to the
workspace host and AOS verifies the refreshed catalog. The host remains the
source of truth.

## Refresh and failure behavior

One coordinator per runtime refreshes discovery initially, after native
invalidation, on focus, and after reconnect. Hermes also polls every five
seconds while the page is visible. Overlapping refreshes are coalesced and do
not steal selection. Unknown Session ownership is never assigned to the
currently selected Agent.

Hiding an Agent does not delete its native definition, archive its Sessions, or
change ownership. A failed mutation or refresh leaves the last confirmed native
catalog visible with an explicit error; AOS never fabricates a successful
metadata change.
