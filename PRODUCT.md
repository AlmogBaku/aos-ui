# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

AOS is for people who operate several provider-owned AI agents and need to follow their conversations, delegated work, decisions, and execution state without losing which agent or session owns an event.

## Product Purpose

AOS provides one calm workspace for selecting a primary Agent, resuming its Sessions, observing nested Subagents, and tracking session-scoped Todos. Success means users can move between active work streams confidently while delayed events, unsupported provider capabilities, and failures remain explicit and correctly scoped.

## Positioning

AOS is a UI for native harnesses, with Agent creation and rich messages around
their conversations. Hermes is the primary and first-supported harness;
OpenClaw and OpenCode use separate integrations behind the same harness-runtime
boundary. The browser connects to the gateway over a single ACP v2 WebSocket per
tab. Explicit fixtures remain available.

## Operating Context

Users work in a three-pane desktop workspace or a focus-managed narrow-screen layout. They select a primary Agent, open or create an Agent-bound Session, converse through Assistant UI, respond to questions and permissions, inspect rich tool activity, follow Subagents, and review session history and Todos. English and Hebrew are first-class locales.

## Capabilities and Constraints

- An Agent is a provider-owned primary agent; a Session belongs to exactly one Agent; a Subagent is a nested delegated run; Todos belong to the Session.
- Native runtimes own durable conversations and execution. Assistant UI owns their frontend projection, composer, queue, and thread lifecycle.
- Provider data is authoritative. Session read state is provider-owned: the
  browser reports the focused Session and the runtime decides when it becomes
  read; on runtimes that support it the operator can also mark a Session unread
  or read from its row menu. Client-owned state is limited to view preferences,
  manually opened recent tabs, per-visit selection restoration, notification
  preferences, and a content-free Activity snapshot persisted locally in the
  browser.
- The Agent catalog includes visible and hidden ordinary primary Agents; only visible, selectable Agents appear in the workspace roster. Creators, native/system definitions, and Subagents are excluded from management. Visibility and creator role come from native metadata. Unsupported native mutations are read-only; AOS has no management server or Agent registry. Creator-owned Sessions are listed by the runtime like any other Session; the creator itself never appears in the roster or Manage Agents.
- One engine is selected per deployment, with multiple Agents and Sessions. Native harnesses own execution, persistence, credentials, and Agent configuration outside this checkout. Unsupported capabilities remain explicit.
- On configured real runtimes, Agent creation opens a creator-owned Session that the browser alone projects as a `New Agent` draft row in the Agent rail with exactly one Session, until the provider catalog lists the Agent the creator stamped with that Session's id and no turn or question in the Session is still open. The stamp is provider data, so the draft ends on every device and after any reload. Without a stamp, the draft persists until the Session is deleted (Discard draft) or 48 hours since last activity; selecting a draft shows no Session tab strip and no inspector. The hidden creator identity never appears in the ordinary roster or management catalog. Creation uses the portable `aos-agent-creator` skill, and the creator writes the Agent with its harness's own CLI or files; AOS ships no creation tool. A created Agent that the harness lists as hidden ends the draft too, with a notice that it still needs its operator. There is no ownership transfer and no automatic first Session for the created Agent. Public fixture/demo mode intentionally omits Agent creation. Native harnesses can initiate inbound Sessions without a browser.
- Provider events retain their originating Agent and Session. Delayed events may update their own cache but never the visible Session.
- Rich tools always have safe, inspectable fallbacks. Browser-side code execution is limited to MCP App views — such as the AOS UI charts, maps, stats, and artifact views — in a double iframe on the deployment's one sandbox origin, under each view's own CSP; terminal/filesystem/VCS surfaces and provider hosting are out of scope. Agent-written HTML shown inside the artifact view runs its own scripts in a frame of its own with an opaque origin, under a policy that reaches no network directly, with in-memory storage for the life of the preview and https links relayed to the workspace.
- An Artifact is a provider-owned deliverable that an Agent explicitly publishes: with a `MEDIA:` line where the harness defines that convention, or a trusted provider-native delivery tool such as Hermes text-to-speech. Ordinary file edits and paths mentioned in prose are not Artifacts. Published images, audio, and video show inline in conversation; other files download. An image or a file opens in the side panel, and the inspector lists every file the Session published.
- An Agent shows a file to the user with `present_artifact` from the AOS UI tools MCP server: the conversation shows a live card that renders PDFs (fitted to the card, with selectable text, keyboard paging, and an outline and page list the reader opens), images, audio and video (played on demand, read only when Play is pressed), plain text, and Agent-written HTML with its scripts in an isolated frame. PDFs and images zoom by pinch, Ctrl with the wheel, the zoom keys, or the controls above them. A file over its kind's preview limit (64 MiB for a PDF, image, audio, or video; 25 MiB for HTML; 2 MiB for text) offers download, and open where the browser shows that kind, instead of a preview. The card's controls are Refresh, Download, Full screen, Open in new tab, and pip; pip moves the view to the side panel, and Full screen covers the viewport under the side panel's header. Open in new tab is offered only for PDFs, images, audio, and video, which the browser shows itself; the gateway serves every other file as plain text. The gateway serves the file; the view reads it through `readServerResource`, which the `aos-ui` server fulfills from the gateway's file route, server to server. Folder rules in `mcpApps.files` govern which paths may be served.
- Where the provider exposes it, context-window usage is surfaced per Session. Model and effort can be selected before or during a run via `session/set_config_option`. In-progress runs can be steered without creating a new run. `/btw` asks a side question in an archived fork and answers it in a tray above the composer. Sessions support rename, pin, archive, delete, and mark unread/read.
- Deep links to a specific Agent and Session resolve even when the Session is past the first catalog page, using `session/resume` with `_meta.hgw.agentId`.

## Activity and Live Notifications

Session read state is provider-owned: the browser reports which Session is
exposed, and the runtime decides when that Session becomes read. On runtimes
that support it, the operator can also mark a Session unread or read from its
row menu. Activity
presents the resulting history alongside inline conversation state, coalesced
in-app notices, and default-on live browser notifications. Completion in the
exact visible, focused Session is already read and suppresses alerts. Other
Sessions in a focused workspace produce unread markers and one coalesced notice.
Hidden tabs and visible but unfocused windows/apps deliver eligible OS
notifications; when the gateway is configured for Web Push, notifications reach
the operator's devices even with no AOS tab open.

**Notification content.** Each notification is about one Session. Its title is
the Agent name, falling back to the Session title, then "AOS". The body carries
the state ("Needs your input", "Turn failed", or "Finished") and the Session
title; on input requests a second body line shows the question or permission
text — a preview of at most 200 characters, credential-masked, flattened to one
line, with "+N more" when further questions remain. Pieces are isolated for
bidirectional text. A newer state of the same Session replaces its older
notification. Lock-screen privacy is the OS Show Previews setting; AOS adds no
toggle. Tapping a notification opens the owning Session.

Notification preferences are on by default. The browser asks for permission
once, from a click on an inline card that appears after the operator's first
message; "Not now" opts out durably and settings can re-enable. Three
categories: input requests, failures, completions. A short in-tab audio cue
plays for input requests and failures (not completions) only in the focused tab
for events in another Session. OS notifications use the OS default sound and
follow OS Do Not Disturb; the in-tab cue is page audio and does not. Bursts
coalesce per category (3 s / 5 s / 20 s windows), but each window delivers one
push per Session; a push older than one already sent for that Session is
skipped. Cross-device suppression: push is not sent while the operator is
present on any device (foreground, active within ~3 minutes; 60-second
heartbeat). After presence lapses, an away tab holds notifications 60 seconds
and a closed workspace ~2 seconds, enough for a reload to reconnect; a Session
on screen never alerts. Events the gateway re-sends when a tab connects never
raise an OS alert, an in-app notice, the in-tab sound, or the bell's ring.
Guest sessions receive no notifications. Permission denial and unsupported
browsers preserve Activity. Multiple tabs elect one delivery tab. Clicks focus
AOS and validate provider ownership before selecting the owning Agent and
Session; deleted targets remain unavailable.

Content goes only to devices whose registration was refreshed within 30 days.
Every app open refreshes it, and an open page re-sends after a day; older
devices receive the notification without content. Registrations idle for 90 days
are removed.

**Activity pane.** The bell opens an inbox of Sessions, not an event history.
It has two groups, "Waiting for you" then "Unread". Each row shows the Agent
tile and name, a relative time, the Session title, a status dot, the question on
waiting rows, and "Turn failed" on failed rows. The whole row opens the Session.
Mark read clears one Session; waiting rows have none, because only answering
clears waiting. Mark all read is enabled only when some counted Session is
unread and not waiting. An empty pane shows "Nothing needs you right now."
Notification settings sit behind a header button, in a view inside the same
drawer with Back. The bell, the inbox, and the Agent tile badges count only
Sessions whose Agent has a rail row. Read Sessions leave the pane; the Session
list is the history. Browsing the drawer marks nothing read.

**Muting an Agent.** The operator can mute an Agent's notifications from its
row's menu (right click on the rail, long press on the phone) or with the
Notifications switch in Manage Agents, wherever the runtime can store the mute.
The mute is the runtime's, so it holds on every device. A muted Agent's events
raise no OS notification, push or in-tab, no in-app notice, chime, or ring.
Its Sessions still appear in the inbox, in a "Muted" group listed last, and Mark
all read covers them; the bell does not count them. Its tile keeps its own count
in neutral gray with a bell-off mark beside the name, and does not hop. A mute
set on a hidden Agent is kept and takes effect once the Agent is shown again.

**Bell.** The badge count uses the status color of the highest state among
counted Sessions: orange (warning) for waiting, else red (destructive) for
failed, else green (success) for unread. Running never colors it. The accessible
name lists the states, e.g. "Activity, 4 unread, 1 waiting for you, 1 failed".
When a Session newly starts waiting, the bell swings once (about 0.7 s) at the
in-tab chime moment, even with sound off. It does not ring for the Session on
screen, for re-sent events, twice within 3 s, or under reduced motion.

The browser's stored Activity snapshot holds preferences only and stays
content-free. The gateway activity feed covers all Sessions visible to the
connection. Fixtures exercise deterministic scenarios, and the other native
adapters expose Activity only when the ACP `initialize` response includes
`_meta.hgw.extensions.activity: true`. Browser and OS policies can delay or
suppress delivery. The Activity bell is in the desktop Agents heading and mobile
header, with an accessible unread count, keyboard-managed drawer,
English/Hebrew support, and reduced motion.

## Brand Commitments

The product name is AOS. Product language is concise, calm, and operational. The interface may take inspiration from the restrained spatial hierarchy of modern dark chat products, but uses original branding, terminology, and visual details.

## Evidence on Hand

The frontend uses Vite, React, Tailwind, and shadcn with static production hosting. Integration readiness requires automated and live acceptance evidence; implementation alone is not proof. No testimonials, customer logos, benchmarks, pricing, or deployment claims are available and future work must not fabricate them.

## Product Principles

1. Preserve ownership: every Agent, Session, Subagent, Todo, and event has an unambiguous scope.
2. Make system state legible: running, waiting, failed, stale, expired, malformed, and unsupported states are visible and actionable.
3. Prefer provider truth over duplicated client state.
4. Keep the workspace calm under complexity through progressive disclosure and restrained visual hierarchy.
5. Keep the workspace developable and testable through deterministic fixtures,
   while reserving real-runtime-only capabilities for provider harnesses.

## Accessibility & Inclusion

English LTR and Hebrew RTL are first-class. Chrome, statuses, times, validation, tool labels, and accessibility labels are localized while conversation content remains verbatim with automatic direction. The interface must support keyboard navigation, focus restoration, reduced motion, streamed-status announcements, sufficient contrast, and textual alternatives for charts and maps.
