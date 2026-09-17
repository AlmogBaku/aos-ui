# Hermes runtime adapter

This package maps the Hermes dashboard API to the provider-neutral
`ServerRuntime` boundary. It is the worked V1 adapter, not a transport template
for other harnesses.

Read the [runtime adapter authoring guide](../../../../docs/development/runtime-adapter-authoring.md)
for shared obligations. [`UPSTREAM.md`](UPSTREAM.md) records the pinned MIT
sources and attribution. [`TURN-LIFECYCLE.md`](TURN-LIFECYCLE.md) defines the
native `/api/ws` turn boundaries and their AG-UI mapping.

## Package map

- `adapter.ts` composes normalized workspace, run, command, rewind, interaction,
  content, and capability operations.
- `dashboard-client.ts` owns validated HTTP reads and durable mutations.
- `transport.ts` owns the multiplexed JSON-RPC WebSocket, request correlation,
  native event routing, heartbeat, and reconnect.
- `attachment-registry.ts` maps durable Sessions to live Hermes Sessions and
  applies retention and warm-idle release.
- `run.ts` converts native execution frames into ordered AG-UI segments.
- `history.ts` converts authoritative native history and strips native context
  envelopes and filesystem details.
- `interactions.ts` answers Hermes' server-to-client `clarify` and `approval`
  JSON-RPC requests: it validates them, presents AG-UI interrupts, and responds
  on the request handle Hermes is waiting on.
- `slash-commands.ts` validates and bounds the native command catalog.
- `content.ts`, `workspace.ts`, and `tool-data.ts` normalize their corresponding
  provider surfaces.

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
- A redirect can close one assistant generation and begin another without a
  second logical run or `RUN_STARTED`.
- `session.interrupt` requests Stop; the coordinator remains `stopping` until a
  terminal event or authoritative idle result.
- A recognized slash command may return output, prefill, alias, or submit work.
  Unknown slash text remains a prompt, and alias traversal is bounded.
- Edit and Retry use authoritative message identities. Commands do not combine
  with rewind.
- A question or approval arrives as a server-to-client JSON-RPC request, not as
  an event, and is answered on that request. A request AOS cannot render is
  declined so the channel answers `-32601` and the agent proceeds; an
  unanswerable request would otherwise park the turn until its native deadline.
- A pending question or approval retains the Session. Its answer is a complete
  AG-UI resume, not a new Hermes prompt.
- Native attachment/context envelopes and paths are parsed before normalized
  history is returned.
- Any lost native mutation acknowledgement is uncertain and is never retried
  automatically.
