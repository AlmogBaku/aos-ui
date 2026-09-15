---
name: aos-runtime-adapter
description: Add, audit, or debug a server-side AOS runtime adapter while preserving normalized AG-UI execution and native harness semantics.
---

# Work on an AOS runtime adapter

Read `AGENTS.md`,
`docs/development/runtime-adapter-authoring.md`, and the selected runtime's
guide and research before proposing changes. Treat
`docs/design/aos-runtime-gateway-architecture.md` and
`docs/design/aos-runtime-gateway-v1.md` as normative.

## Establish the native contract

Inspect the maintained native SDK, client, protocol source, and behavior tests.
Write a concise capability and lifecycle matrix covering durable and live
identities, authoritative reads, streaming, controls, interactions, recovery,
retention, and unsupported operations. Finish this step only when every
operation in scope has a cited native behavior or an explicit unavailable
result.

## Preserve ownership

Map native behavior onto `packages/proxy/core/runtime.ts` and the existing
`SessionCoordinator`. Keep connection topology, live identities, attachment,
retention, payload validation, and native recovery inside the adapter. Keep
admission, normalized run state, control serialization, subscriber fanout, and
AG-UI segment identity in the coordinator.

Use standard AG-UI for messages, reasoning, tools, activity, lifecycle, and
interrupts. Use an AOS extension only for a demonstrated behavior AG-UI does
not express. Require evidence from the current adapter and another native
runtime before generalizing provider mechanics into shared core or protocol.

## Choose the work path

- **Add:** implement one observable operation end to end, beginning with a
  focused provider-neutral behavior test.
- **Audit:** compare every in-scope capability and lifecycle transition with
  native sources, then report concrete mismatches and protecting tests.
- **Debug:** trace one failing operation across native input, adapter
  conversion, coordinator, normalized stream, and browser materialization.
  Test the first boundary where actual state diverges from expected state.

For mutations, identify admission, acknowledgement, and uncertainty before
coding. Reconnect reconciles authoritative state and never resends an uncertain
mutation. Browser queueing, active steering, provider queueing, commands,
rewind, and interrupt resume remain distinct operations.

## Complete the work

Run the focused adapter tests and the affected provider-neutral conformance and
browser tests. Confirm capability fidelity, stable ownership, AG-UI event
ordering, cross-Session isolation, reconnect without prompt replay, and native
data non-disclosure. Report native evidence, changed mappings, verification,
and any capability left unavailable.
