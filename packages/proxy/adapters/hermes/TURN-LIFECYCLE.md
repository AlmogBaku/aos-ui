# Hermes turn lifecycle

This document explains how the Hermes `/api/ws` protocol represents one model
turn and how the AOS Hermes adapter maps that turn to AG-UI. It is a reference
for contributors changing `transport.ts`, `run.ts`, recovery, or history.

## The socket is not the turn

Hermes exposes a persistent, multiplexed JSON-RPC WebSocket at `/api/ws`. One
connection carries requests and events for multiple Sessions. Opening or
closing that socket is a connection-lifecycle event; it does not start or end a
model turn.

The layers have separate responsibilities:

1. `transport.ts` authenticates the socket, correlates JSON-RPC responses, and
   delivers ordered native events.
2. `run.ts` validates events for one attached Session and maps their semantics
   to an AG-UI run segment.
3. The shared run coordinator owns subscriber replay and terminal settlement.
4. Authoritative Hermes HTTP history reconciles durable transcript state.

Do not infer turn completion from a request acknowledgement, a tool result, a
socket close, or the end of an individual assistant text segment.

## Native event boundaries

Hermes emits `message.start` when it accepts a prompt. A turn may then contain
any number of assistant text segments and tool calls in source order.

| Native event                                 | Meaning                                                                                                                                       | Ends the turn?               |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| `message.delta`                              | Streaming text for the current assistant segment.                                                                                             | No                           |
| `message.interim`                            | Seals assistant commentary before subsequent work. `already_streamed` says whether preceding deltas already carried the text.                 | No                           |
| `tool.start`, `tool.progress`                | Tool execution lifecycle.                                                                                                                     | No                           |
| `tool.complete` success                      | A successful tool result.                                                                                                                     | No                           |
| `tool.complete` failure                      | A failed tool attempt. Hermes may recover with more text and tools.                                                                           | No                           |
| `message.complete` with `status: "complete"` | Successful terminal assistant outcome for the native turn.                                                                                    | Yes                          |
| `message.complete` with `status: "error"`    | Terminal failure of the native turn. `recoverable` preserves a failed turn for retry; it does not keep that same turn running.                | Yes                          |
| `error`                                      | Ambiguous failure notification. Hermes also uses it for advisory failures, such as a rejected pending model switch, while the turn continues. | No; reconcile Session status |
| `session.info` with `running: false`         | Fallback settlement signal when the expected completion frame was lost or native work stopped abnormally.                                     | Fallback only                |

Hermes sets the Session to idle after emitting the turn's completion frame. A
consumer should prefer `message.complete` as the semantic terminal event and
use idle `session.info` only to avoid leaving a run permanently pending when a
terminal frame is absent.

## Interwoven text and tools

A valid turn can look like this:

```text
message.start
tool.start
tool.complete (failed)
message.interim ("I will split this into two calls.")
tool.start
tool.complete (succeeded)
tool.start
tool.complete (succeeded)
message.complete (status=complete, final text)
session.info (running=false)
```

Only the successful `message.complete` finishes this turn. The failed tool is
retained as inspectable execution history, and `message.interim` becomes a
completed assistant text message before the next tool. Dropping the interim
frame loses source ordering and can make live output disagree with Hermes
Desktop or authoritative history.

The Session `default/20260915_194141_f06b78` exposed this failure mode: one
tool failed, Hermes continued with two successful tools, and the native turn
finished with assistant text. The adapter must not translate the failed tool
into `RUN_ERROR` or `RUN_FINISHED`.

## Incident findings

The native logs for `default/20260915_194141_f06b78` show two distinct cases
that must not be conflated:

- The turn accepted at `2026-09-15 19:44:53` included a failed `skill_view`,
  continued through later tools and model calls, and ended with native
  `status=complete`. AOS must preserve the failed tool and every interim text
  boundary without settling the run.
- The turns accepted at `2026-09-16 07:28:26` and `07:37:00` continued through
  several tools, then Hermes exhausted three Bedrock retries because the model
  rejected assistant-message prefill. Hermes ended both native turns with
  `status=error` and `error_retained=True`. Those are genuine terminal provider
  failures, not AOS-generated early termination.

The screenshots combined three presentation defects around those native
facts: live AOS output dropped `message.interim`, refreshed history previously
hid the failed tool classification, and the public terminal error omitted a
useful friendly explanation. Fix those mappings without changing a genuine
native terminal error into an indefinitely running AOS execution.

A later native-producer audit found that `error` is not itself a terminal
contract. Hermes emits it when applying a pending model switch fails, while the
source explicitly keeps the current model and allows the turn to continue. AOS
therefore reconciles Session status instead of translating the frame directly
to `RUN_ERROR`.

## AG-UI mapping rules

The Hermes adapter applies these rules:

- `message.interim` closes only the current AG-UI text message. It does not emit
  `RUN_FINISHED` or `RUN_ERROR`.
- When `already_streamed` is false, the adapter emits the interim text before
  closing that text message. When it is true, the adapter closes the text
  already received through `message.delta` without duplicating it.
- Tool failure terminates that tool call, not the run.
- A successful `message.complete` closes outstanding message/tool structures
  and emits exactly one `RUN_FINISHED`.
- A terminal native error becomes a sanitized, localized AOS run error. Native
  exception strings and transport details must not reach the browser.
- A generic `error` frame records a possible failure and triggers an
  authoritative Session-status read. `running` or `waiting` keeps the run open;
  `idle` confirms the failure. A failed status read cannot prove termination,
  so later message or Session lifecycle events remain authoritative.
- Idle `session.info` is a fallback terminal edge, never the primary completion
  rule.
- Live mapping and authoritative history must use the same tool-result failure
  classifier so refresh does not erase a failed attempt.

## Why AOS does not import `GatewayClient`

Hermes' web [`GatewayClient`](https://github.com/NousResearch/hermes-agent/blob/b29b352c9eeec261fc17b09bd5402b5a8a0c4a8b/web/src/lib/gatewayClient.ts)
is a browser-specific wrapper around
[`JsonRpcGatewayClient`](https://github.com/NousResearch/hermes-agent/blob/b29b352c9eeec261fc17b09bd5402b5a8a0c4a8b/apps/shared/src/json-rpc-gateway.ts).
The implementation package is a private Hermes workspace package named
`@hermes/shared`, version `0.0.0`; it is not a supported published dependency.
AOS also runs its transport server-side and requires boundaries absent from the
browser client:

- bounded socket frames, decoded JSON depth, node count, and HTTP bodies;
- server credential handling without exposing the Hermes token;
- sanitized native errors and explicit uncertain-mutation outcomes;
- exact Session routing and bounded multi-subscriber fan-out;
- authoritative HTTP reconciliation under the AOS coordinator.

For those reasons AOS adapts the wire protocol instead of importing the browser
class. This is intentional adaptation, but it creates compatibility work. When
the pinned Hermes revision changes, compare `transport.ts` with the upstream
shared client for authentication, heartbeat, sequence watermark, replay epoch,
and live/replay race behavior. Compare `run.ts` separately with Hermes Desktop's
event reducer for message, tool, and terminal semantics. Transport parity does
not replace correct turn interpretation.

## Verification contract

Focused tests must cover at least these sequences:

- failed tool, interim assistant text, successful tools, successful completion;
- already-streamed interim text without duplication;
- successful completion emits exactly one terminal run event;
- terminal message error and idle fallback produce a friendly public error;
- an advisory `error` while Hermes is running permits later tools and a
  successful completion;
- an `error` confirmed by authoritative idle status produces one friendly
  terminal error;
- reconnect replay preserves native sequence without duplicating live frames;
- refreshed history retains both failed and successful tools in source order.
