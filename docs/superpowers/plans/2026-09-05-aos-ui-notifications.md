# AOS Live Notification Support

## Goal

Enable a user to start work in a AOS chat, switch to another website while
the AOS tab remains loaded, receive exactly one useful browser notification
when the Agent finishes, fails, or needs input, and return directly to the
originating Agent and Session.

V1 provides four surfaces: existing inline state, a persistent in-app Activity
inbox, ephemeral in-app notices, and opt-in browser notifications while a
AOS page is loaded. Closed-app Web Push, email, mobile push, remote approval,
and scheduled-work notifications are explicitly out of scope.

## Global Constraints

- Assistant UI remains authoritative for threads, messages, runs, branches, and
  composer state. Provider data remains authoritative for Agent and Session
  lifecycle. The Activity store is delivery/read-state UX only.
- Every activity event must be validated and remain scoped to its originating
  Agent and `threadId`; delayed events must never leak across selections.
- OpenCode gets full activity support, fixture mode mirrors it deterministically,
  and AG-UI initially supports only its active Session with that limitation
  visible in settings.
- Do not persist or display message, prompt, tool, todo, question, permission, or
  error content in OS notifications or Activity storage. Store opaque IDs and
  resolve current Agent/Session labels from workspace data.
- Browser notification permission is requested only from an explicit user
  gesture. Browser notifications are generic, background-only, and never expose
  approval actions.
- A terminal notification represents an observed run lifecycle transition. Do
  not infer completion from an unpaired idle snapshot or replay old events after
  reload/reconnect.
- English LTR and Hebrew RTL are first-class. Include localized copy, logical
  layout, accessible names, keyboard/focus behavior, screen-reader semantics,
  and reduced-motion behavior.
- Follow strict TypeScript/ESM and existing repository patterns. Use TDD: every
  new behavior must have a test observed failing for the expected reason before
  production implementation.

## Product Behavior

- Opening AOS may show existing unread Activity but never prompts for
  notification permission.
- Starting a run, tool activity, todo changes, plans, and child-subagent progress
  remain inline and never generate notification events.
- A completion in the exact visible and focused Session creates an already-read
  Activity entry and no toast or OS notification.
- A completion in another Session while AOS is focused creates unread
  Activity, navigation markers, and one coalesced in-app notice; OS delivery is
  suppressed.
- When AOS is hidden, minimized, or not focused, observed completion,
  terminal failure, unresolved question/permission, Agent activation, and Agent
  activation failure may send one generic OS notification according to category
  settings.
- Answered or withdrawn questions/permissions become resolved in Activity and do
  not create a follow-up OS alert.
- User cancellation is inline only; retry starts a distinct lifecycle.
- Clicking an OS notification focuses AOS, validates the target, selects the
  correct Agent and Session, and focuses the relevant conversation/request. A
  deleted target focuses AOS and presents an unavailable Activity item
  without stale navigation.
- Multiple tabs synchronize Activity/read state and elect one OS-delivery tab.
- Denied/unsupported browser notifications leave Activity fully functional and
  do not cause repeated permission requests.
- If every AOS tab/browser is closed, V1 cannot observe or notify about new
  events.

## Public Interfaces

Extend the provider-neutral contract with:

```ts
type WorkspaceActivityEvent =
  | ActivityBase & { type: "run-started"; lifecycleId: string }
  | ActivityBase & {
      type: "run-finished" | "run-failed"
      lifecycleId: string
    }
  | ActivityBase & {
      type: "attention-requested"
      attentionKind: "question" | "permission"
      requestId: string
    }
  | ActivityBase & { type: "attention-resolved"; requestId: string }
  | ActivityBase & { type: "agent-ready" | "agent-activation-failed" }

type ActivityBase = {
  id: string
  agentId: string
  threadId: string
  occurredAt: string
}
```

Add optional `WorkspaceAdapter.subscribeActivity(listener, onError)` and
`WorkspaceCapabilities.activityEvents`.

## Task 1: Activity contract, policy, and store

Implement the shared activity domain and tests.

- Add the public activity event union, optional workspace subscription, and
  capability flag.
- Create focused `lib/notifications` modules for activity records, versioned
  serialization, store transitions, visibility/delivery policy, and an
  injectable browser-notification port interface. Pure domain modules must not
  read browser globals directly.
- Persist only opaque event/Agent/thread/lifecycle/request IDs, type, timestamp,
  read/resolved state, and delivery bookkeeping. Reject malformed stored data
  and enforce Agent/thread ownership at ingestion.
- Upsert by stable event ID, tolerate out-of-order duplicate events, correlate
  lifecycle start/terminal events, preserve unresolved attention, retain no more
  than 200 entries, and expire resolved/non-attention entries after 30 days.
- Mark events read immediately only when their exact Agent/thread is selected and
  the page is visible and focused; otherwise mark them read when opened.
- Define browser preferences: master switch off by default; completion, failure,
  and input categories on behind the master switch.
- Test policy combinations, malformed hydration, retention, deduplication,
  ordering, ownership rejection, lifecycle pairing, resolution, and privacy.

## Task 2: OpenCode activity publisher

Publish authoritative activity events from the existing OpenCode event stream.

- Map busy/retry to one `run-started` event per active lifecycle. Map idle to
  `run-finished` only when an observed lifecycle is active. Map terminal session
  errors to `run-failed` and close that lifecycle.
- Map question/permission asked and replied/rejected events to stable attention
  request/resolution events without including their content.
- Map successful draft promotion to `agent-ready` and terminal activation failure
  to `agent-activation-failed`.
- Reuse the adapter's ownership/sequence guarantees and existing single global
  subscription; do not create a second provider event connection.
- Treat retry status as continued running when the lifecycle is already active,
  ignore duplicate idle/error events, and never emit completion from initial
  metadata hydration.
- Add focused adapter tests covering happy paths, duplicates, retry, question,
  permission, error, activation, out-of-order events, and cross-Agent isolation.

## Task 3: Fixture and AG-UI activity publishers

Expose the shared capability in the remaining runtimes.

- Add deterministic fixture scenarios for completion, failure, question,
  permission, resolution, Agent ready/failure, duplicates, stale targets, and
  delayed events from a non-selected Session.
- Adapt the AG-UI active runtime's observed run lifecycle to activity events for
  its active Session only. Do not imply workspace-wide background coverage.
- Ensure capability detection reflects whether each runtime actually publishes
  events and preserves strict runtime selection with no synthetic fallback.
- Add fixture and AG-UI contract/integration tests for lifecycle pairing,
  ownership, limitation behavior, and subscription cleanup.

## Task 4: In-app Activity UI

Integrate Activity into the provider-neutral workspace without displacing the
Agent inspector.

- Add a notification coordinator/provider at the existing client workspace
  boundary. Subscribe once to workspace activity and current Agent/thread focus.
- Add an Activity bell to the desktop Agents heading and mobile header. Show an
  accessible numeric unread count capped visually at `9+`.
- Open a focus-managed Activity drawer with `Needs attention` and `Earlier`
  sections, Open actions, Mark all read, and settings. Deleted targets remain
  visible as unavailable/resolved entries.
- Add non-color-only unread/attention indicators to Agent and Session navigation.
- Show one coalesced visible-app notice when events arrive outside the selected
  Session. Use `role="status"` for completion/routine updates and `role="alert"`
  only for attention requests and failures. Never move focus automatically.
- Resolve labels at render time from current workspace data and use generic
  fallbacks when data is unavailable.
- Add complete English/Hebrew copy, logical CSS, RTL tests, keyboard/focus tests,
  accessible-name/live-region tests, and reduced-motion behavior.

## Task 5: Browser notification delivery

Implement opt-in live OS notification delivery behind an injectable port.

- Add Activity settings explaining that V1 works only while at least one AOS
  tab is loaded. Request permission only within the master-toggle click handler.
- Re-check browser support/permission on hydration and window focus. Keep denied
  and unsupported states explanatory and do not automatically re-request.
- Deliver only when `document.visibilityState !== "visible"` or
  `document.hasFocus()` is false and the event category is enabled.
- Use localized generic text only: `A turn finished`, `A turn failed`, or `Your
  Agent needs input`; title `AOS`; favicon icon; event timestamp; stable tag;
  `renotify: false`; no custom sound, `requireInteraction`, or notification
  actions.
- Synchronize entries/preferences/read state with `BroadcastChannel`, falling
  back to storage events. Elect one delivery tab using Web Locks when available
  and an expiring local-storage lease otherwise; the notification tag is only a
  secondary deduplication guard.
- On click, close the notification, focus the existing window, validate the
  target, and dispatch selection/focus through the workspace coordinator.
- Catch API/constructor failures without breaking Activity. Do not add a service
  worker, Push API subscription, backend route, or manifest badge.
- Test default/granted/denied/unsupported states, user-gesture prompting,
  visibility/focus policy, payload privacy, click routing, constructor failure,
  multi-tab election/failover, and cleanup.

## Task 6: Integration, E2E, and documentation

Complete cross-system scenarios and operator documentation.

- Add Playwright coverage for: focused-session suppression; another-Session
  in-app notice; background completion; question; failure; stale target; denied
  permission; and two-tab single delivery. Mock the browser Notification API at
  its boundary; do not test browser-framework internals.
- Verify Activity behavior in desktop/mobile layouts, English/Hebrew, RTL,
  keyboard flow, and reduced motion.
- Update README and PRODUCT documentation with the four notification surfaces,
  privacy behavior, provider coverage, live-tab limitation, browser permission
  requirements, and explicit V1 exclusions.
- Run fresh final verification: `bun run test`, `bun run typecheck`,
  `bun run lint`, `bun run build`, `bun run test:e2e`, `git diff --check`, and
  `git status --short`.
- Perform a real supported-desktop-browser smoke test in fixture mode: enable
  notifications, start a delayed run, switch websites, observe exactly one
  generic OS alert, click it, and confirm the correct Agent/Session. Repeat the
  critical path for input, failure, Hebrew, denied permission, and two tabs. If
  the execution environment cannot observe host OS notifications, report this
  gate explicitly as requiring human verification rather than claiming it ran.

After all tasks pass their scoped review gates, run a merge-base-to-head final
review emphasizing provider ownership, privacy, cross-tab concurrency,
accessibility, suppression policy, and test gaps. One consolidated fix wave and
one scoped re-review are allowed for final findings.
