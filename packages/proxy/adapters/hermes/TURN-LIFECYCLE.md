# Hermes turn lifecycle

This document explains how the Hermes `/api/ws` protocol represents one model
turn and how the AOS Hermes adapter maps that turn to the proxy-owned run
vocabulary defined in `packages/proxy/core/events.ts`. The ACP layer then
delivers those events to the browser. This is a reference for contributors
changing `gateway.ts`, `gateway-socket.ts`, `run.ts`, recovery, or history.

## The socket is not the turn

Hermes exposes a persistent, multiplexed JSON-RPC WebSocket at `/api/ws`. One
connection carries requests and events for multiple Sessions. Opening or
closing that socket is a connection-lifecycle event; it does not start or end a
model turn.

The layers have separate responsibilities:

1. `vendor/hermes-shared/` (`JsonRpcGatewayClient`) correlates JSON-RPC
   responses, drives the heartbeat, and manages socket generations.
   `gateway.ts` / `gateway-socket.ts` wrap it with the token dial, bounded
   decoding, error classification, and one event fan-out.
2. `run.ts` validates events for one attached Session and maps their semantics
   to a proxy-owned run segment.
3. The shared run coordinator owns subscriber replay and terminal settlement.
4. Authoritative Hermes HTTP history reconciles durable transcript state.

Do not infer turn completion from a request acknowledgement, a tool result, a
socket close, or the end of an individual assistant text segment.

## Native event boundaries

Hermes emits `message.start` when it accepts a prompt. A turn may then contain
any number of assistant text segments and tool calls in source order.

| Native event                                 | Meaning                                                                                                                                                                                                                                                    | Ends the turn?               |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| `message.delta`                              | Streaming text for the current assistant segment.                                                                                                                                                                                                          | No                           |
| `message.interim`                            | Seals assistant commentary before subsequent work. `already_streamed` says whether preceding deltas already carried the text.                                                                                                                              | No                           |
| `tool.start`, `tool.progress`                | Tool execution lifecycle.                                                                                                                                                                                                                                  | No                           |
| `tool.complete` success                      | A successful tool result.                                                                                                                                                                                                                                  | No                           |
| `tool.complete` failure                      | A failed tool attempt. Hermes may recover with more text and tools.                                                                                                                                                                                        | No                           |
| `message.complete` with `status: "complete"` | Successful terminal assistant outcome for the native turn.                                                                                                                                                                                                 | Yes                          |
| `message.complete` with `status: "error"`    | Terminal failure of the native turn. `recoverable` preserves a failed turn for retry; it does not keep that same turn running. `text` is the model's own prose only when `partial` is true; without it Hermes composed the copy that explains the failure. | Yes                          |
| `error`                                      | Ambiguous failure notification. Hermes also uses it for advisory failures, such as a rejected pending model switch, while the turn continues.                                                                                                              | No; reconcile Session status |
| `session.info` with `running: false`         | Fallback settlement signal when the expected completion frame was lost or native work stopped abnormally.                                                                                                                                                  | Fallback only                |

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

## Run vocabulary mapping rules

The Hermes adapter applies these rules (the ACP layer translates the
proxy-owned vocabulary for the browser):

- `message.interim` closes only the current text message in the proxy-owned vocabulary. It does not emit
  `RUN_FINISHED` or `RUN_ERROR`. The adapter rotates its own message id at that
  boundary, but the ACP translation pins every chunk and tool call of the run to
  the segment's first id, so the browser streams the one assistant turn that
  history later replays.
- When `already_streamed` is false, the adapter emits the interim text before
  closing that text message. When it is true, the adapter closes the text
  already received through `message.delta` without duplicating it.
- Tool failure terminates that tool call, not the run.
- A successful `message.complete` closes outstanding message/tool structures
  and emits exactly one `RUN_FINISHED`.
- A terminal native error becomes a localized AOS run error, never an assistant
  message: a failed completion's `text` is published as assistant text only when
  `partial` is true, so Hermes' own failure copy never reads as a reply. The run
  error carries the catalogue headline for the mapped code, followed by Hermes'
  own error text bounded to 500 characters and dropped whole when it trips the
  adapter's redaction rule. Transport details never reach the browser.
- A generic `error` frame records a possible failure and triggers an
  authoritative Session-status read. `running` or `waiting` keeps the run open;
  `idle` confirms the failure. A failed status read cannot prove termination,
  so later message or Session lifecycle events remain authoritative.
- Idle `session.info` is a fallback terminal edge, never the primary completion
  rule.
- Live mapping and authoritative history must use the same tool-result failure
  classifier so refresh does not erase a failed attempt.
- Hermes retains a failed turn (`error_retained=True`) in the Session's inflight
  snapshot instead of its transcript, and only `session.resume` returns that
  snapshot. A history load whose last page ends with an unanswered prompt
  therefore resumes the Session once and restores the retained turn with the
  same public failure code and message the live run published, restoring the
  retained assistant text only when Hermes streamed prose before failing. No
  other history load resumes anything.

## How AOS vendors `JsonRpcGatewayClient`

AOS vendors `JsonRpcGatewayClient` and its companions byte-identical from
`NousResearch/hermes-agent apps/shared` at commit
`47685348eaca9d673719003b9e03a71becfa6423` into
`vendor/hermes-shared/`. The vendored client owns correlation, per-call
timeouts and `AbortSignal`, JSON-RPC error typing, the `gateway.ping`
heartbeat, socket generations, and server-to-client request routing. The AOS
`gateway.ts` wrapper owns the token dial, eager dial and jittered redial, 20 s
heal grace, auth-close stop, 8 MiB wire-fault guard, 2 MiB event drop, bounded
JSON, three-way error classification (rejected with code / uncertain when
written / unavailable when nothing was written), one event fan-out, epoch
changes, and `close()`. Vendored replay is disabled (`replay: false`) because
`run.ts` owns native replay and catch-up.

See [`vendor/hermes-shared/UPSTREAM.md`](vendor/hermes-shared/UPSTREAM.md) for
per-file hashes, the shim rationale, and the sync recipe. When the pinned
revision changes, compare `gateway.ts` and `gateway-socket.ts` against the
updated shared client for authentication, dial parameters, sequence watermarks,
and replay epoch behavior. Compare `run.ts` separately against Hermes Desktop's
event reducer for message, tool, and terminal semantics. Transport parity does
not replace correct turn interpretation.

## Verification contract

The following test titles in `run.test.ts` cover the sequences described in
this document. Changing any of these behaviors requires updating the test.

- `keeps one AOS run while redirecting into a distinct assistant generation`
- `keeps the run open across a failed tool, interim text, and recovered tools`
- `seals already-streamed interim text without duplicating it`
- `settles a run when its native turn later completes`
- `treats a failed message completion as a run error with its cause`
- `keeps Hermes partial output visible when message completion fails`
- `never publishes Hermes' failure copy as assistant text`
- `terminalizes a confirmed idle native failure with its bounded cause`
- `keeps the run open after an advisory native error while Hermes is running`
- `completes the advisory-error sequence without a run error`
- `fails the terminal-error sequence once at the idle edge`
- `replays missed events from the same Hermes epoch before buffered live events`
- `reattaches an interrupted active run and replays without resubmitting the prompt`
- `classifies a changed Hermes replay epoch as reset-required`
- `live and refreshed Hermes tool projection agree` (describe block with multiple cases)
