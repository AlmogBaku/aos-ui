# Hermes runtime adapter

This package maps the Hermes dashboard API to the provider-neutral
`ServerRuntime` boundary. It is the worked V1 adapter, not a transport template
for other harnesses.

Read the [runtime adapter authoring guide](../../../../docs/development/runtime-adapter-authoring.md)
for shared obligations. [`UPSTREAM.md`](UPSTREAM.md) records the pinned MIT
sources and attribution. [`TURN-LIFECYCLE.md`](TURN-LIFECYCLE.md) defines the
native `/api/ws` turn boundaries and their mapping to the proxy-owned run vocabulary.
The ACP layer translates that vocabulary to the browser.

## Package map

- `adapter.ts` composes normalized workspace, run, command, rewind, interaction,
  content, and capability operations.
- `dashboard-client.ts` owns validated HTTP reads and durable mutations.
- `vendor/hermes-shared/` is a byte-identical copy of the `JsonRpcGatewayClient`
  and its companions from upstream `apps/shared` at the pinned commit. It owns
  correlation, per-call timeouts, heartbeat, socket generations, and
  server-to-client request routing. See `vendor/hermes-shared/UPSTREAM.md`.
- `gateway.ts` wraps the vendored client with the token dial, eager dial and
  jittered redial, 20 s heal grace, auth-close stop, bounded wire decoding, and
  three-way error classification.
- `gateway-socket.ts` enforces the 8 MiB frame guard and supplies the
  socket factory used by `gateway.ts`.
- `http.ts` provides bounded REST helpers for all non-WebSocket Hermes calls.
- `attachment-registry.ts` maps durable Sessions to live Hermes Sessions,
  rebinds after a heal, invalidates on 4001/4007 rejection, clears on restart,
  and applies running-aware warm-idle release.
- `run-native.ts` defines typed native outcomes and the Hermes rejection-code
  table used to classify run errors.
- `run.ts` converts native execution frames into ordered proxy-owned run
  events: the single attach path, per-Session contiguity and catch-up,
  discovery by open-turn ring scan, one turn outcome, the settlement watcher,
  and the failure catalogue.
- `history.ts` converts authoritative native history and strips native context
  envelopes and filesystem details.
- `interactions.ts` answers Hermes' server-to-client `clarify` and `approval`
  JSON-RPC requests: it validates them, re-delivers `open_requests` on
  reattach, presents normalized pending requests, and responds on the request handle
  Hermes is waiting on. A `request.cancel` subscription expires pending
  requests.
- `slash-commands.ts` validates and bounds the native command catalog.
- `tool-data.ts` is the single tool projection owner: `run.ts` and `history.ts`
  both read a tool call through `projectHermesToolCall` and its outcome through
  `projectHermesToolOutcome`, so a live turn and a refreshed transcript cannot
  disagree about a tool's public name, arguments, error state, result, or
  artifacts. `media-artifacts.ts` remains the artifact authority behind it.
- `content.ts` and `workspace.ts` normalize their corresponding provider
  surfaces.

Colocated and integration tests cover the package's observable behavior.
`core/session-coordinator.test.ts` protects provider-neutral execution
semantics; adapter tests protect Hermes mapping and transport mechanics.

## Hermes-specific traps

- Durable stored Session IDs are public; live Session IDs and socket generations
  are adapter-private and may change after reconnect.
- One WebSocket multiplexes many Sessions. Releasing a Session attachment must
  not close the shared connection.
- HTTP history is authoritative. WebSocket replay restores timely incremental
  output but cannot replace reconciliation.
- `session.redirect` implements active-turn steering. Both `redirected` and
  `queued` are accepted results and must not be replayed.
- Hermes persists an accepted redirect immediately, as a plain user row whose
  `api_content` carries the interrupted-response scaffold. A from-start resume
  therefore drops the journal acknowledgements that history already carried,
  counted in acceptance order, so the correction is announced once.
- A redirect can close one assistant generation and begin another without a
  second logical run or `TurnStarted`.
- `session.interrupt` requests Stop; the coordinator remains `stopping` until a
  terminal event or authoritative idle result.
- A recognized slash command may return output, prefill, alias, or submit work.
  Unknown slash text remains a prompt, and alias traversal is bounded.
- Edit and Retry use authoritative message identities. Commands do not combine
  with rewind.
- A question or approval arrives as a server-to-client JSON-RPC request, not as
  an event, and is answered on that request. A request whose method AOS cannot
  render is claimed and left unanswered, because `-32601` cancels the prompt and
  another Hermes renderer may be waiting on it for a shared Session. A request
  AOS renders but cannot use (no bound Session, an unusable payload) is declined
  so the channel answers `-32601` and the agent proceeds instead of parking the
  turn until its native deadline. Reaching the pending-request cap claims the
  request too: that limit is AOS', and the next resume re-delivers whatever is
  still open.
- A pending question or approval retains the Session. Its answer is a complete
  replies turn, not a new Hermes prompt.
- Native attachment/context envelopes and paths are parsed before normalized
  history is returned.
- Any lost native mutation acknowledgement is uncertain and is never retried
  automatically.
