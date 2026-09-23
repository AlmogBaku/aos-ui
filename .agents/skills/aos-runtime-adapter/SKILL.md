---
name: aos-runtime-adapter
description: Add, audit, or debug how the AOS proxy adapts a native harness onto the ACP v2 browser wire: native client → ServerRuntime/ServerRunEngine → SessionCoordinator → ACP translation → browser.
---

# Work on an AOS runtime adapter

Read `AGENTS.md`, `docs/development/runtime-adapter-authoring.md`, and the
selected runtime's guide before proposing changes. Treat the gateway
architecture doc as normative. Consult `packages/proxy/adapters/hermes/README.md`
and `TURN-LIFECYCLE.md` for a worked example.

## Pipeline and file ownership

| Layer | Files |
| --- | --- |
| Native transport, identity, retention, validation, conversion | `packages/proxy/adapters/<kind>/`: `adapter.ts`, `factory.ts`, `capabilities.ts`, `client.ts` / `dashboard-client.ts`, `content.ts`, `history.ts`, `interactions.ts`, `run.ts`, `workspace.ts`, `native-schemas.ts`; Hermes also has `run-attach.ts`, `run-failures.ts`, `run-frames.ts`, `run-native.ts`, `run-settlement.ts`, `run-state.ts`, `slash-commands.ts`, `attachment-registry.ts`, `media-artifacts.ts`, `vendor/` |
| Seam | `packages/proxy/core/runtime.ts` (`ServerRuntime`, `ServerRunEngine`, `ServerRunHandle` with `stop`/`steer?`/`recoveryPosition`, `SessionScope`); vocabulary `core/events.ts`; coordination `core/session-coordinator.ts`; rows `core/session-rows.ts`; stages `core/attachment-stages.ts` |
| ACP adapter | `packages/proxy/acp/agent.ts` (method handlers, `GUEST_METHODS`, connect-time hydration), `agent-sessions.ts` (per-connection ownership, list cursor), `session-attachment.ts` (`reportExecution`/`reportUsage`/`reissuePending`, `_aos/*` emission), `translate/run-events.ts`, `translate/history.ts`, `translate/interrupts.ts`, `translate/updates.ts` (pure reducers from run vocabulary to ACP), `config-options.ts`, `read-state.ts`, `activity-feed.ts`, `service.ts`/`socket.ts`, `validation.ts`, `types.ts` |
| Contract | `packages/protocol/acp.ts` (`_meta.aos` schemas, `AOS_METHODS`, error codes); browser consumer `src/runtime-adapters/aos/acp/*` |

## ACP surface coverage

| ACP surface | Run-vocabulary / seam input | Adapter obligation |
| --- | --- | --- |
| `session/update` text / reasoning / tool chunks | `RunEvent` kinds (`TEXT_MESSAGE_*`, `REASONING_*`, `TOOL_CALL_*`) | Emit the correct kinds from `run.ts` |
| `plan_update` `_meta.aos.todos` | `ACTIVITY_SNAPSHOT` / `ACTIVITY_DELTA` carrying Todos | Populate the activity payload |
| `usage_update` | `SessionContextResponse` (`session-attachment.ts:85-91, 245, 305-323`) | Implement `context(agentId, publicSessionId)` (`core/runtime.ts:247`) or declare unavailable |
| `session/request_permission` / `elicitation/create` | `PendingRequest` (`translate/interrupts.ts`, incl. `_allow_session`, multi-select `items.enum`) | Emit `PendingRequest` from `interactions.ts` |
| `resource_link` `artifact://<id>` chunk | `CUSTOM` event `aos.artifact` with `AosArtifactDescriptor` (`translate/run-events.ts:135`); history `data` part `aos.artifact` (`translate/history.ts:33`) | Emit from `run.ts`/`history.ts` on a `present_artifact` receipt, a native `MEDIA:` line, or a trusted delivery receipt; implement `artifact()` (`core/runtime.ts:264-268`) |
| `_aos/steer_accepted` | `steer` handle + `CUSTOM` event `aos.steer.accepted` (`core/session-coordinator.ts:809-817`) | Implement `handle.steer` |
| `session_info_update` `{status, archived, unread}` | Catalog rows (`SessionRows`) | Implement `getSession` / `listSessions` |
| `_aos/catalog_invalidated` | `subscribeCatalogChanges` callback | Implement `subscribeCatalogChanges` on `ServerRuntime` |
| `_aos/session/update` intents | `sessionTitle` / `sessionArchival` / `sessionDeletion` capabilities | Route to `mutateSession(agentId, runtimeSessionId, "PATCH" \| "DELETE", body?)` (`core/runtime.ts:226-231`; called from `acp/agent-sessions.ts:184`) gated by those capabilities |
| Read state | `sessionReadState` capability + `unread` field on session row | Write `{ unread: false }` via `mutateSession(agentId, runtimeSessionId, "PATCH", { unread: false })` (`acp/read-state.ts:83-88`) |
| `session/set_config_option` | `models` / `thoughtLevel` capabilities | Implement `updateModel(agentId, publicSessionId, patch: SessionModelUpdateRequest)` (`core/runtime.ts:242-246`); response carries the settled model state |

Note: `_aos/session_invalidated` is defined in the protocol but is not emitted
by the proxy.

## Register a new adapter

One new runtime kind = one `RuntimeConfig` variant added to
`packages/proxy/config.ts:107-143` + one adapter package + one `case` in
`packages/proxy/adapters/create-runtime.ts:12-21`.
`packages/proxy/architecture.test.ts:55-69` fails until all three exist and the
selector file is the only file with the `case`.

## Preserve ownership

Keep connection topology, live identities, attachment, retention, payload
validation, and native recovery inside the adapter. Keep admission, normalized
run state, control serialization, subscriber fanout, and run segment identity
in the coordinator. Emit the proxy-owned run vocabulary (`core/events.ts`); use
a `CUSTOM` event only for behavior the vocabulary cannot express.

## Attachments and Artifacts

Treat attachment and media planes as different public concepts:

| Native input | Public projection | Read authority |
| --- | --- | --- |
| User attachment/context envelope such as Hermes `@file:` | User message attachment | The adapter's admitted, Session-scoped attachment record |
| `aos-ui` `present_artifact` receipt `{ok, type: "aos.artifact", artifact: {path, filename, mimeType?}}` | Assistant Artifact | The receipt, after `safeArtifactPath` (`core/artifact-path.ts`) |
| Harness `MEDIA:/absolute/path` line (Hermes, OpenClaw) | Assistant Artifact; line removed from prose | The line, after `safeArtifactPath`; `MediaLineFilter` (`core/media-lines.ts`) |
| Successful delivery tool output such as Hermes text-to-speech | Assistant Artifact | The trusted native tool receipt |
| Path mentioned in prose, or an unclaimed `MEDIA:` line | Nothing, or `[Media unavailable]` | None |

Parse attachment envelopes server-side. Preserve authorship and safe filename,
MIME, size, and opaque identity; remove native paths, injected context,
filesystem warnings, and private retrieval URLs.

An Artifact reaches the browser as a `resource_link` content block whose `uri`
is `artifact://<id>`, and is fetched over
`GET /api/aos/v1/agents/:agentId/sessions/:sessionId/artifacts/:artifactId`
(`packages/proxy/routes/content.ts:87`). Keep the reference in a private
Agent-and-Session-scoped mapping; expose a deterministic opaque Artifact ID.
`artifact()` resolves the id only within that Session, reads through the
harness's own file interface, and caps bytes at `MAX_ARTIFACT_BYTES` (25 MiB).
Pass every native tool name through `canonicalAosToolName`
(`core/aos-tool-names.ts`) so prefixed `aos-ui` MCP tools reach the browser as
`render_chart`, `render_map`, `render_stats`, and `present_artifact`; the first
three are MCP Apps, flagged at call start by `withMcpApps`. When the
harness loads MCP servers per Session, enable `aos-ui` inside the adapter before
each turn and fail the turn if that fails (OpenClaw `#enableAosTools`,
`adapters/openclaw/run.ts:1253-1272`).
For Hermes text-to-speech, grant an Artifact only when a successful
`text_to_speech` result lists the same supported audio reference in `file_path`
or `file_paths` **and** its `media_tag`. Redact paths from the public tool
result. Buffer fragmented `MEDIA:` lines across deltas; suppress a trusted
delivery marker and never grant authority to an unmatched one.

## Choose the work path

- **Add:** implement one observable operation end to end, beginning with a
  focused provider-neutral behavior test.
- **Audit:** compare every in-scope capability and lifecycle transition with
  native sources, then report concrete mismatches and protecting tests.
- **Debug:** trace one failing operation across native input → adapter
  conversion (`run.ts`/`history.ts`) → coordinator journal (`observe`/`snapshot`)
  → ACP outbound (`translate/*`, `session-attachment.ts`) → browser projection
  (`src/runtime-adapters/aos/acp/session-projector.ts`). Test the first
  boundary where actual state diverges from expected state.

For mutations, identify admission, acknowledgement, and uncertainty before
coding. Reconnect reconciles authoritative state and never resends an uncertain
mutation.

## Complete the work

Run the focused adapter tests and the affected provider-neutral conformance and
browser tests. Test suites by boundary: `adapters/<kind>/*.test.ts`,
`core/session-coordinator.test.ts`, `acp/translate/*.test.ts`,
`acp/agent.test.ts`, `src/runtime-adapters/aos/acp/*.test.ts`, and the
in-process ACP lane gate `e2e/support/provider-mock.ts` +
`e2e/aos.runtime.spec.ts`.

Confirm: capability fidelity across both lanes (guest projection in
`packages/proxy/guest/acp.ts` and `packages/proxy/auth/guest-runtime-projection.ts`),
`_meta.aos.sequence` monotonic on replay, reconnect via `session/resume`
`after`/`resync` without prompt replay, and the `vendor/` + `UPSTREAM.md` +
snapshot-test rule for vendored native clients. For attachments or delivered
media, cover split stream markers, history restoration, exact receipt
correlation, opaque retrieval, untrusted and mismatched paths both with and
without a delivered Artifact, failed receipts, and missing bytes. Report native
evidence, changed mappings, verification, and any capability left unavailable.
