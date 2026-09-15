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

## Separate attachment and media planes

Treat these as different public concepts even when the provider represents
both with filesystem paths:

| Native input | Public projection | Read authority |
| --- | --- | --- |
| User attachment/context envelope such as Hermes `@file:` | User message attachment | The adapter's admitted, Session-scoped attachment record |
| Successful delivery tool output such as Hermes text-to-speech | Assistant Artifact | The trusted native tool receipt |
| Assistant-authored path or unmatched `MEDIA:` text | Safe unavailable fallback | None |

Parse attachment envelopes server-side. Preserve authorship and safe filename,
MIME, size, and opaque identity; remove native paths, injected context,
filesystem warnings, and private retrieval URLs from history and live output.

Treat provider media markers as delivery syntax, never as authority. For
Hermes text-to-speech, grant an Artifact only when a successful
`text_to_speech` result lists the same supported audio reference in
`file_path` or `file_paths` **and** its `media_tag`. Keep the reference in a
private Agent-and-Session-scoped mapping and expose a deterministic opaque
Artifact ID. Redact paths from the public tool result. Buffer fragmented
`MEDIA:` lines across deltas, preserve surrounding prose, suppress a trusted
delivery marker, and never grant authority to an unmatched marker. When the
assistant message has no delivered media, replace an unmatched marker with a
path-free unavailable fallback. When that message already has a trusted media
Artifact, suppress additional unmatched markers as redundant. Durable history
and live streaming must derive the same Artifact without rerunning the tool.

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
data non-disclosure. For attachments or delivered media, cover split stream
markers, history restoration, exact receipt correlation, opaque retrieval,
untrusted and mismatched paths both with and without a delivered Artifact,
failed receipts, and missing bytes. Report native evidence, changed mappings,
verification, and any capability left unavailable.
