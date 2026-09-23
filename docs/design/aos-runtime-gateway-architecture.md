# AOS runtime gateway architecture

This document describes the shipped proxy server. Every H2 is tagged
`Status: Implemented` or `Status: Target (not implemented)`. All target
content is collected in [§19 Target](#19-target-not-implemented).

**Related references** (this doc links, not restates):

- Full `_aos/*` wire table → [`docs/runtimes/acp.md`](../runtimes/acp.md)
- Adapter obligations and five lifetimes → [`docs/development/runtime-adapter-authoring.md`](../development/runtime-adapter-authoring.md)
- Operator-facing summary → [`docs/architecture.md`](../architecture.md)
- Hermes lifecycle → [`packages/proxy/adapters/hermes/README.md`](../../packages/proxy/adapters/hermes/README.md)
  and [`TURN-LIFECYCLE.md`](../../packages/proxy/adapters/hermes/TURN-LIFECYCLE.md)

---

## 1. Scope and legend {#1-scope-and-legend}

**Status: Implemented**

The AOS proxy is a Bun HTTP + WebSocket server that sits between the browser
and one configured native AI runtime. It normalizes the native API behind:

- one ACP v2 WebSocket per connection (operator and guest lanes)
- REST byte and discovery routes

The proxy holds no workspace database. The native runtime owns all durable
state. The browser works only with the normalized surface.

**Legend used in this document:**

| Term         | Meaning                                                                  |
| ------------ | ------------------------------------------------------------------------ |
| ACP          | Agent Client Protocol v2 (`@agentclientprotocol/sdk/experimental/v2`)    |
| Session      | One conversation, identified by a public `threadId` the browser supplies |
| Turn segment | One continuous provider execution between starts and stops               |
| Coordinator  | `SessionCoordinator` — the process-local turn admission and journal      |
| Attachment   | Per-connection view of one Session on the coordinator                    |
| Lane         | `operator` or `guest` — the ACP connection kind                          |

---

## 2. System shape {#2-system-shape}

**Status: Implemented**

One deployment = one runtime.

```
browser (operator or guest)
        |
        | ACP v2 WebSocket  /api/aos/v1/acp  or  /api/guest/v1/acp
        | REST bytes+discovery  /api/aos/v1/*  or  /api/guest/v1/*
        v
Bun HTTP server  (server.ts:startProxyServer → bunServe)
        |
        | Hono app + ACP socket mount  (cli/serve.ts:117-163)
        v
AcpConnectionContext  (acp/types.ts:53-67)
        |
        | per-connection Session registry  (acp/agent-sessions.ts)
        v
SessionCoordinator  (core/session-coordinator.ts:378)
        |
        | ServerTurnEngine
        v
ServerRuntime / ServerTurnEngine  (core/runtime.ts:67-100, 192-280)
        |
        | one adapter  (adapters/create-runtime.ts:12-21)
        v
Hermes | OpenClaw | OpenCode  (native transport)
```

`createConfiguredProxy` (`composition.ts:26-36`) loads secrets once and
constructs one `RuntimeInstance` shared by every listener.

---

## 3. Trust boundaries {#3-trust-boundaries}

**Status: Implemented**

Every REST response carries security headers (`app.ts:50-56`):

```
cache-control: no-store
content-security-policy: default-src 'none'; frame-ancestors 'none'
referrer-policy: no-referrer
x-content-type-options: nosniff
x-frame-options: DENY
```

The guest listener adds its own CSP to static and runtime-config responses
(`cli/serve.ts:27-33`).

Origin is checked at every write surface: the ACP upgrade
(`acp/service.ts:55`), REST upload routes (`routes/content.ts:59`), and the
invitation endpoint (`routes/invitations.ts:19-21`).

All log values pass through `redactForLog` (`redaction.ts`), which replaces
credential-bearing field values with `"[REDACTED]"`, strips query strings and
credentials from URLs, and reports every `Error` as `"Upstream request failed"`.
Secret files are absolute paths read once at startup (`secrets.ts:6-23`); the
secret bytes never appear in config, logs, or responses.

---

## 4. Listeners and lanes {#4-listeners-and-lanes}

**Status: Implemented**

### 4.1 Operator lane

No application login. Network access grants full operator context; `principalId`
defaults to `"operator"` (`acp/service.ts:50`). Routes: static assets,
`/runtime-config.json`, `/api/aos/v1/*`, `/api/aos/v1/acp` (WebSocket,
`cli/serve.ts:118`).

### 4.2 Guest lane

Physically separate listener and origin (validated different from operator,
`config.ts:166-184`). JWT: type `aos-guest-invitation+jwt`, HS256, issuer
`aos-invite`, audience `aos-guest` (`auth/guest-invitation.ts:6-9`). Claims
include `deploymentId`, `runtimeId`, `agentId`, `ref`, optional `firstTurn`,
expiry. Default TTL 259 200 s (`config.ts:159`).

API prefix `/api/guest/v1`; ACP at `/api/guest/v1/acp`. Paths `/auth` and
`/hermes` → 404; non-health `/api/*` → 404 (`cli/serve.ts:23,44-62`).

An unauthenticated guest's `initialize` omits runtime info (`acp/agent.ts:320`).
`auth/login` redeems the token. Connection closes on expiry (`guest/acp.ts:191-200`).

Guest extensions (`acp/agent.ts:101-112`): `steer:false`, `rewind:false`,
`artifacts:true`, `agents:false`, `invalidation:false`, `activity:false`,
`readState:false`, `focus:false`, `guestProjection:true`.

Allowed methods for a redeemed guest (`acp/agent.ts:89-95`): `session/resume`,
`session/prompt`, `session/cancel`, `session/close`, `_aos/session/focus`.

### 4.3 Shared runtime instance

Both listeners share one `RuntimeInstance`. Per-connection `SessionRows` and
`AttachmentStageRegistry` are lane-local (`cli/serve.ts:117-141`).

---

## 5. The single ACP socket {#5-the-single-acp-socket}

**Status: Implemented**

The browser opens one WebSocket per surface. The 101 response carries
`Acp-Connection-Id` (`acp/service.ts:15`), a UUID the proxy mints per
connection.

**Handshake** (`initialize`): the response `_meta.aos` carries `version`,
`lane`, and the `extensions` map (`protocol/acp.ts:100-120`; `acp/agent.ts:318-346`).
Guests receive the `GUEST_EXTENSIONS` map and an `authMethods` list with the
invite method.

**Per-connection Session ownership**: the per-connection `Sessions` object
(`acp/agent-sessions.ts:221-303`) maps public Session ids to owning Agent ids.
Only Sessions listed, created, or resumed on this connection are addressable.
`adopt` trusts a client-supplied `agentId` for `session/resume` until the
provider read confirms it.

**Upgrade rules**: the server checks the Origin header and refuses upgrades
that do not match `publicOrigin`. A cap of `operatorEventPeers` is enforced per
socket mount (`cli/serve.ts:123,139`).

For the full method table see [`docs/runtimes/acp.md`](../runtimes/acp.md).

---

## 6. Turn vocabulary and ACP translation {#6-turn-vocabulary-and-acp-translation}

**Status: Implemented**

The proxy owns a closed turn vocabulary defined in `core/events.ts`
(`TurnEventKind`). Native adapters emit these event kinds; the ACP layer
translates them to browser-facing ACP payloads. Neither end depends on the
other's wire format.

Every `session/update` on a turn segment carries `_meta.aos.sequence` and
`_meta.aos.turnId` (`protocol/acp.ts`), so the browser can position
cursor-bearing reconnects.

**AOS extension events** map to vendor wire notifications:

| Turn event kind      | Wire form                                                            |
| -------------------- | -------------------------------------------------------------------- |
| `steer-accepted`     | `_aos/steer_accepted` notification                                   |
| `artifact-published` | `resource_link` block, `uri: "artifact://<id>"`, on the turn's chunk |

Mapping source: `acp/translate/turn-events.ts`.

History replay runs through the same translators, so the browser receives
identical shapes whether an event is live or replayed.

---

## 7. SessionCoordinator and adapter ownership split {#7-sessioncoordinator-and-adapter-ownership-split}

**Status: Implemented**

For adapter obligations and the five lifetimes see
[`docs/development/runtime-adapter-authoring.md`](../development/runtime-adapter-authoring.md).

**Coordinator key facts** (`core/session-coordinator.ts`):

| Fact                                                                    | Location                                |
| ----------------------------------------------------------------------- | --------------------------------------- |
| Scope key: `agentId + "\0" + sessionId`                                 | `:218`                                  |
| Idempotent re-admission (duplicate `turnId` replays from journal)       | `:511-528`                              |
| Conflict (different turn on non-idle scope → `ServerTurnConflictError`) | `:543-549`                              |
| Single-flight (`#admissions` set blocks concurrent starts)              | `:551-552,578-580`                      |
| Per-lane capacity: `maxActiveExecutions` / `maxGuestActiveExecutions`   | `:1193-1206`; limits `config.ts:95-105` |
| Controllers set; `#withControl` serialises stop+steer                   | `:514,565,746,797`                      |
| Steer dedup: 256 per execution, oldest evicted                          | `:216,821-824`                          |
| Stop states: `running` → `stopping` → terminal                          | `:740-769`                              |

**Adapter engine** (`core/runtime.ts:67-100`): `start`, `recover`, `discover?`
(post-process-loss), `stop`/`steer?` on handle, and adapter-private
`recoveryPosition` (`{epoch, lastSeen}`, `:56-63`). All three factories
(`hermes/factory.ts:63-71`, `openclaw/factory.ts:191-198`,
`opencode/factory.ts:54-61`) pass the same config limits.

---

## 8. Requests {#8-requests}

**Status: Implemented**

A turn segment ends in either a success or a `turn-requires-action` outcome,
which carries one or more `PendingRequest` items (`core/events.ts`). The coordinator
retains the execution in `waiting-for-input`.

Delivery: each pending request is sent as a server→client `requestPermission`
or `elicitation.create` call with a `requestId` in `_meta.aos`
(`protocol/acp.ts:315-341`; `acp/session-member.ts:665-716`).

Answering every request starts a new turn segment whose `TurnInput` carries
the `replies` array (`acp/session-member.ts`, `#settle`;
`session-coordinator.ts`).

A stale request (the execution has moved on) returns JSON-RPC error
`-32003 staleRequest` (`acp/validation.ts:58-59`).

On reconnect, pending requests are re-issued via `reissuePending`
(`acp/session-member.ts:317-324`).

---

## 9. REST byte planes {#9-rest-byte-planes}

**Status: Implemented**

All write REST routes require the correct `Origin` header. Default JSON body
cap 16 KiB (`routes/http.ts:61`). Stage registry: 256 entries, 300 s TTL
(`core/attachment-stages.ts:13-22`); full → HTTP 503 `turn_capacity_exceeded`.

| Route                                | Limit                            |
| ------------------------------------ | -------------------------------- |
| `POST …/attachments/stage`           | 35.5 MB (`routes/content.ts:62`) |
| `GET …/artifacts/:id`                | —                                |
| `POST …/audio/transcribe`            | 7.5 MB (`:109`)                  |
| `POST …/audio/speak`                 | 40 KB (`:131`)                   |
| `GET /api/aos/v1/runtime`            | —                                |
| `POST /api/aos/v1/guest-invitations` | 16 KiB JSON                      |
| `GET /api/aos/v1/healthz`, `/readyz` | —                                |

Guest mirrors the same routes under `/api/guest/v1/` with authorization and
smaller staging limits (`guest/context.ts:37-40`).

---

## 10. Read state, focus, and activity {#10-read-state-focus-and-activity}

**Status: Implemented**

**Read state** (`acp/read-state.ts`): a `_aos/session/focus` notification from
the browser arms a debounce timer (400 ms, `FOCUS_DEBOUNCE_MS`). When it fires
the proxy writes a read watermark to the provider. A floor of 5 000 ms
(`REACK_FLOOR_MS`) prevents redundant writes. The provider's `sessionReadState`
capability is checked once and cached. Guest connections are inert: `focus`
calls return without writing (`read-state.ts:62-81`).

**`SessionRows`** (`core/session-rows.ts:12-30`): the proxy-local row cache.
A write guard of 10 s (`READ_GUARD_MS`) prevents a list read that races the
mark-read write from clearing an optimistic `unread: false`.

**Activity feed** (`acp/activity-feed.ts:7-10`): per-connection buffer, max
200 events, max age 30 days. Hydration reads one catalog page (100 entries,
`HYDRATION_PAGE_SIZE`). Events are sent as `_aos/activity` notifications on
connect and as live feed items thereafter.

Guest activity is scoped to the invited Agent only (`guest/acp.ts:234-243`).

---

## 11. Invalidation and Session-change signals {#11-invalidation-and-session-change-signals}

**Status: Implemented**

| Notification                        | Trigger                                                                                                                                       |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `_aos/catalog_invalidated`          | `subscribeCatalogChanges` fires (Hermes `sessions.changed`, `acp/agent.ts:648-650`; `adapter.ts:1070-1075`); also sent after `session/delete` |
| `session_info_update` (`_meta.aos`) | `SessionRows` subscriber on a changed row (`acp/agent.ts:641-647`; `core/session-rows.ts:12-17`)                                              |
| `_aos/activity`                     | Activity feed push (execution events, unread changes)                                                                                         |

`_aos/session_invalidated` tells one connection that its live subscriber for a
Session was dropped for falling behind the fanout bounds; the browser answers by
resuming that Session from the start.

---

## 12. Reconnect and replay {#12-reconnect-and-replay}

**Status: Implemented**

**Browser**: exponential backoff 250 ms → 5 000 ms
(`src/runtime-adapters/aos/acp/connection.ts:59-60`). Each Session re-attaches
via `session/resume` with `_meta.aos.after` (last sequence) and `turnId`
(`protocol/acp.ts:168-174`). `resync: true` in the response → re-resume with
`replayFrom:{type:"start"}` (`connection.ts:329-338`). Guest re-logins before
resuming (`connection.ts:374-377`).

**Proxy**: coordinator journal holds every event of a turn segment, bounded by
`maxReplayEvents`/`maxReplayBytes` (`hermes/factory.ts:63-71`). Adjacent text
deltas merge on read to save replay size while keeping cursors exact
(`session-coordinator.ts:73-77,141-145,310-320`). `resync` is set when the
journal cannot answer the cursor (`acp/agent.ts:419-428`).

The `discover` preamble reconstructs authoritative state before replay
(`acp/agent.ts:464-471`). `reissuePending` re-delivers pending requests after
reconnect (`acp/session-member.ts:317-324`). Adapter-private
`{epoch,lastSeen}` positions the native stream (`core/runtime.ts:56-63`).

**Accepted steering survives replay exactly once.** The browser projects
`_aos/steer_accepted` as a user turn appended in arrival order. A provider that
persists the correction the moment it accepts it makes that turn part of
authoritative history, so a from-start resume announces each persisted
correction exactly once: the history row wins and the journal's acknowledgement
of it is dropped, in acceptance order.

---

## 13. Limits and backpressure {#13-limits-and-backpressure}

**Status: Implemented**

**ACP socket** (`acp/socket.ts:7-17`):

| Limit                        | Value                     |
| ---------------------------- | ------------------------- |
| Max inbound frame            | 1 100 000 bytes (≈1.1 MB) |
| Inbound rate window          | 1 s, 64 frames, 256 KiB   |
| Outbound queue               | 256 frames, 4 MiB         |
| Rate exceeded close code     | 1008                      |
| Output overloaded close code | 1013                      |

**Per-lane execution caps** (`config.ts:95-105`): `activeExecutions` (global)
and `guestActiveExecutions`. Both are validated: guest cap must not exceed
global cap (`config.ts:166-172`).

**REST caps**: stage 35.5 MB, transcribe 7.5 MB, speak 40 KB, default JSON
16 KiB (`routes/http.ts:61`). Stage registry: 256 entries, 300 s TTL.

**Subscriber fan-out** (`config.ts:95-105`): `subscriberEvents` and
`subscriberBytes` bound the coordinator journal and per-subscriber replay.

---

## 14. Configuration and secrets {#14-configuration-and-secrets}

**Status: Implemented**

`ProxyConfig` (`config.ts`): `listen` (host union `{127.0.0.1,::1,0.0.0.0,::}`

- port; wide hosts require `exposure: "private-container"`, `:72-82`);
  `publicOrigin` (HTTPS or loopback HTTP); `keys` (1–3 HS256 secret keys,
  `:84-93`); `limits` (`:95-105`); `runtime` (discriminated union `kind ∈
{hermes,openclaw,opencode}`, `:107-143`); `guest.invitations.ttlSeconds`
  (default 259 200 s, `:159`); `guest` must use a separate origin and listener
  (`:166-184`); `shutdownGraceMs`.

`parseProxyConfig` stays opaque for library callers: it rejects the whole
config with `"Invalid proxy configuration"` so rejected input containing
secrets is never logged. The startup path is different. `loadProxyConfig` in
`config-file.ts` resolves the path, checks the file, parses the YAML, merges
defaults and `AOS_UI_PROXY_*` overrides, and validates with the exported schema
directly; a failure becomes a `ProxyConfigurationError` carrying the file path
and the field paths (never a value), and `cli.ts` logs it through
`describeStartFailure`, which unwraps only that class into a plain object.
`redactForLog` therefore keeps its every-`Error`-is-opaque invariant for every
other failure while a configuration problem stays readable in the startup log.

**Secret files** (`secrets.ts:6-23`): absolute paths, regular non-symlink
files, permissions `0o600` or tighter, max 8 KiB, read once at startup.

**Shutdown** (`server.ts:226-276`; `cli/serve.ts:86-90`): SIGINT/SIGTERM drains
in-flight requests within `shutdownGraceMs`; both listeners share the grace.

---

## 15. Adapter kinds and selection {#15-adapter-kinds-and-selection}

**Status: Implemented**

`adapters/create-runtime.ts` is the sole selector. No other production module
branches on `kind` (enforced by `packages/proxy/architecture.test.ts:55-69`).
The fixture adapter is browser-only and has no server-side counterpart.

| Kind       | Native client                                                                  | Credential files                        | Steering                                        |
| ---------- | ------------------------------------------------------------------------------ | --------------------------------------- | ----------------------------------------------- |
| `hermes`   | Vendored JSON-RPC WebSocket + HTTP (`adapters/hermes/README.md`)               | `tokenFile`                             | Available (`adapter.ts:719-725`)                |
| `openclaw` | `@openclaw/gateway-client` `GatewayClient` (`adapters/openclaw/client.ts:1-8`) | `deviceIdentityFile`, `deviceTokenFile` | Unavailable (`adapter.ts:379`)                  |
| `opencode` | `@opencode-ai/sdk/v2/client` (`adapters/opencode/client.ts:3`)                 | `passwordFile`                          | Native-steering-unproven (`adapter.ts:141-144`) |

---

## 16. Errors {#16-errors}

**Status: Implemented**

**REST `ErrorCode` values** (`routes/http.ts:3-34`): `unauthenticated`,
`forbidden`, `invalid_request`, `not_found`, `revision_conflict`,
`turn_conflict`, `turn_capacity_exceeded`, `runtime_authentication_required`,
`temporarily_unavailable`, `connection_interrupted`, `uncertain_mutation`,
`internal_error`.

**`ServerRuntimePublicError` codes** (`core/runtime.ts:179-189`): same names
except `turn_conflict` and `internal_error`; maps to JSON-RPC via
`acp/validation.ts:60-92`.

**JSON-RPC extension codes** (`protocol/acp.ts:69-79`): `-32001`
authRequired, `-32002` turnInProgress, `-32003` staleRequest, `-32004`
notFound, `-32005` revisionConflict, `-32006` temporarilyUnavailable,
`-32007` connectionInterrupted, `-32008` uncertainMutation, `-32602`
invalidRequest.

**Vendor stop reasons** on `state_update { state: "idle" }`: `_aos_error`,
`_aos_uncertain` (`protocol/acp.ts:53-57`).

All errors pass through `redactForLog`. Native bodies, credentials, paths, and
stack traces never cross either listener.

---

## 17. Tests that enforce the boundaries {#17-tests-that-enforce-the-boundaries}

**Status: Implemented**

| Test file                                                    | What it checks                                         |
| ------------------------------------------------------------ | ------------------------------------------------------ |
| `packages/proxy/architecture.test.ts:24-44`                  | Native types out of common proxy and browser modules   |
| `packages/proxy/architecture.test.ts:46-53`                  | AG-UI absent from the proxy                            |
| `packages/proxy/architecture.test.ts:55-69`                  | Each runtime selected in exactly one module            |
| `test/architecture/runtime-import-boundaries.test.ts:19-116` | Provider packages do not import each other             |
| `test/architecture/startup-bundle.test.ts:7-37`              | Browser bundle does not contain server code            |
| `packages/proxy/core/session-coordinator.test.ts`            | Coordinator admission, capacity, conflict              |
| `packages/proxy/acp/*.test.ts`                               | ACP protocol, read state, activity feed, socket limits |

---

## 18. Invariants {#18-invariants}

**Status: Implemented**

| #   | Invariant                                                                                            | Checked by                                                        |
| --- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| 1   | One runtime per deployment (`config.ts:151`)                                                         | `architecture.test.ts:55-69`                                      |
| 2   | Adapter boundary: `acp/`,`auth/`,`core/`,`guest/`,`routes/`, browser never import native packages    | `architecture.test.ts:24-44`, `runtime-import-boundaries.test.ts` |
| 3   | AG-UI absent from the proxy                                                                          | `architecture.test.ts:46-53`                                      |
| 4   | `adapters/create-runtime.ts` is the only runtime-kind branch                                         | `architecture.test.ts:55-69`                                      |
| 5   | No synthetic fallback; fixture is browser-only                                                       | runtime-mode validation at startup                                |
| 6   | Guest lane fails closed; extensions `steer`,`agents`,`invalidation`,`activity`,`readState` = `false` | `acp/agent.test.ts`                                               |
| 7   | `guestActiveExecutions` ≤ `activeExecutions`                                                         | `config.ts:166-172` (`superRefine`)                               |
| 8   | Turn control requires registered `controllerId`                                                      | `session-coordinator.ts:746-748`                                  |
| 9   | Steer dedup: same `requestId`+fingerprint → same result; different fingerprint → conflict            | `session-coordinator.ts:786-795,821-824`                          |

---

## 19. Target (not implemented) {#19-target-not-implemented}

**Status: Target (not implemented)**

The following capabilities are in the design direction but have no shipped
implementation:

- **Multi-runtime per deployment.** One config, multiple concurrent runtimes
  with per-runtime namespacing.
- **Multi-tenant operator authentication.** Per-user identity, sessions, and
  OIDC/SAML login before reaching the ACP socket.
- **Principal-specific upstream identities.** Per-user credentials forwarded
  to the native runtime.
- **Multi-worker turn ownership.** Distributing coordinator state across
  processes or machines.
- **Operator authentication cookies.** Server-side cookie jars or trusted
  identity assertions for the operator lane.

Until these are implemented the proxy runs as a single-process, single-runtime,
no-application-login server.

---

## 20. Research basis {#20-research-basis}

**Status: Implemented**

This document is derived from the production source at commit `c05309f`
(2026-09-20). The ACP v2 migration landed in commits `046d3bf`, `64fe9dc`,
`774d1b1`. The browser cutover landed in `92a24f2`; run vocabulary in
`f042380`. Gateway architecture was designed in
[`docs/design/aos-runtime-gateway-v1.md`](aos-runtime-gateway-v1.md) and the
[AOS runtime gateway V1 retrospective](../development/hermes-v1-retrospective.md).
