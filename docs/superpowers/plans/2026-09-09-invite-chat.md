# Same-origin helper and invited chat

Approved implementation spec. Baseline: `d6bafa973ece920f8d3e52803d134fb1fb99ce46`
(current HEAD at execution start), branch `codex/invite-chat`, isolated sibling
worktree. Original uncommitted work is not copied or modified.

## Outcome and boundaries

Optional Go helper solves browser CORS for Hermes and OpenCode and issues
expiring invitation links to one Agent's one conversation. Reuse native
persistence, existing integrations and Assistant UI. No gateway database.
NanoClaw and OpenClaw are documentation-only. Exclude Docker work/tests,
deployment automation, TLS provisioning, SSH management, user administration,
individual revocation, distributed coordination and new runtime implementations.

## Architecture

One executable, one runtime per deployment. Operator listener defaults to
loopback and serves existing frontend/native forwarding with native auth.
Guest listener serves the same build with minimal surface and restricted API;
never operator routes or arbitrary forwarding. Existing deployment is unchanged
when the helper is unused. Externally provided HTTPS secures public hosting;
an existing SSH tunnel may provide the upstream connection.

Gateway core owns compact encrypted JWE invitations, authorization, guest transport and expiry. Adapters own
native authentication, ownership, Session recovery, operations and projections.
Shared chat owns Assistant UI Thread, composer, queue, attachments and voice.
Guest surface owns minimal chrome, branding, welcome and permitted actions.
Provider-neutral conversation interface: resolve, history, send, observe,
cancel and supported conversational operations. Composition selects the adapter.
No native details in guest components or WorkspaceAdapter, browser imports of
native code, generic RPC escape hatch, or second conversational state machine.
Voice services remain independently configurable.

## Invitation and security

Preserve native operator password and Hermes Desktop Session-token auth.
Add local CLI minting, never a public mint endpoint. Compact JWE claims: v=1,
iss=aos-invite, aud=guest origin, iat, exp, agent, ref, optional firstTurn
(editable prefill and private instruction), and ui (lang=en|he, name, logoUrl,
accent, title, message). Ref is stable across renewals; no Session-ID target,
jti, registry or hash-of-token Session identity. Use `alg=dir`, `enc=A256GCM`
with an exact 32-byte base64url key. Maximum token 3 KiB. Validate branding as
bounded text, HTTPS logo and color; no arbitrary HTML/CSS.

URL #invite=<JWE>; immediately clear fragment, POST redeem, store the same JWE in
Secure HttpOnly host-only SameSite=Strict cookie. Validate authenticated encryption, issuer,
audience, version and expiry on every guest operation, exact Origin on mutations.
Reusable until expiry; key rotation invalidates all invites, no individual or
one-use tracking. Expiry ends access/streams but does not auto-stop native runs.
Credentials/upstreams/native paths server-side. Browser supplies no arbitrary
upstream/path. Bind operations to displayed conversation reference to protect
older tabs after another invitation replaces the cookie.

Authorize all history/send/events/edit/regenerate/Stop/attachment/audio actions.
Scope cannot expand through client IDs. Server filters history/events/export:
user-facing messages, safe attachments and supported rich output only. Exclude
reasoning, raw tools/results, metadata and Subagents. Project supported rich
output/questions explicitly, never raw native envelopes. Reject model changes
through fields, commands or executable slash commands; deny management/catalog,
other Sessions and execution approvals. Filtering is not sandboxing or prompt
secrecy: operator restricts native tools; Agent answers may disclose background.

## Native lifecycle

Reference: Hermes exact reserved title derived from ref, scoped profile,
native session.list, create+persist title
before prompting, requery collision winner, follow resolved_id. OpenCode native
namespaced metadata preserving other keys, paginated lookup, verified Agent/root
Session, reject forks/ambiguous matches. In-memory per-ref initialization/send
serialization, single helper instance. Native state recovers after restart;
conflicting/unavailable state fails clearly. Manual rename/archive/delete may
break recovery.

Create only on first submitted message. Link load/dialog/reconnect never prompt.
For a new Session only, OpenCode passes the private instruction through native
`prompt_async.system`; Hermes seeds it as a private, preloaded user-history
instruction during `session.create` so every Hermes transport sends it with the
first participant turn. Hermes does not persist that preloaded row in the native
transcript. The guest projection never returns it. Existing Sessions ignore
renewed-token first-turn fields. This does not promise prompt secrecy: the Agent
may repeat the instruction.
Uncertain send: recover history, report uncertainty, never blind retry.

## Guest UI

Reuse existing Thread, Assistant UI primitives and Dialog; no fork/new design
system. Retain regular runtime-supported attachments, upload/download, voice,
recording/read-aloud, streaming/queue/Stop/edit/regenerate/branches, Markdown,
rich output, copy/export, errors/reconnect. Hide models, reasoning/tools,
Subagents, Agent/Session navigation and management. Genuine native capability
limits remain visible, not artificial minimal reductions. Integrate approved
parallel features without copying dirty unrelated files.

Compact identity/topic header, shared composer. Invitation language initial default;
explicit user preference wins. EN/LTR and HE/RTL, accessible labels, keyboard
focus and reduced motion. Optional welcome Dialog first verified visit;
Continue to chat/close/Escape dismiss; Welcome note reopens; no minimize.
Content-free preference remembers dismissal per conversation. No message means
no dialog/button. Avoid forced mobile keyboard. Dialog never starts Agent.

## Execution and acceptance

- [x] Create worktree from HEAD and record baseline/spec.
- [x] Establish guest interface and deterministic fixtures.
- [x] Gateway authorization and Hermes/OpenCode adapters.
- [x] Existing guest chat with conversational parity.
- [x] Operator setup/auth/minting/recovery/privacy docs and future-runtime notes.
- [x] Focused verification and one integration/security review.

TDD per behavior: failing public-seam test, confirm red, minimum implementation,
green, refactor. DRY fixtures/contracts/components; no speculative abstraction.
Coordinator owns gateway/shared contracts/integration. Three bounded workers:
Hermes adapter, OpenCode adapter, guest UI. Disjoint ownership, no nested agents,
duplicate research or review chains. Research only decisions that may change;
delegate required adjacent blockers narrowly, exclude optional cleanup.

Coverage: valid/tampered/expired/wrong audience; cross-scope/operator/model denial;
native auth and HTTP/streaming; lazy/concurrent creation and restart/reconnect;
metadata/collisions/ambiguity/uncertain sends; no internal payload/export leakage;
scoped attachments/audio and stale tabs; UI parity, welcome/focus/locale.
One desktop and mobile visual check including Hebrew RTL.

Cadence: smallest relevant checks per edit, broader relevant integration only
when connected work needs evidence. Stabilized final gate: relevant unit and
integration tests, Go race/vet, typecheck/lint/build, focused guest/provider
browser journeys once. No routine full E2E, Docker or observability/benchmark
project. Reuse evidence until relevant changes invalidate it. Heavy gates serial
if contention matters; reproduce failures narrowly. Live journey per runtime
(invite/chat/reconnect/unauthorized) only with credentials and approved disposable
targets; clearly report missing live evidence, mocks are not live passes.

## Goal

Implement this spec from HEAD with Hermes/OpenCode decoupling, stateless invites,
native recovery and conversational parity. Enforce scope/server filtering/no
model switching. Deliver focused evidence and docs, honestly reporting live
limitations. No token budget specified. Resume unfinished work, never resurrect
excluded scope. Skills: writing-plans, right-sizing-coding-work, TDD.
