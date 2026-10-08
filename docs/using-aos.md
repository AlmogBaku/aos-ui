# Use AOS

AOS is organized around provider-owned Agents and Sessions. The selected runtime remains authoritative; the browser projects its state and keeps only local view preferences and notification delivery state.

## Choose an Agent and Session

Select an Agent from the roster, then open one of its Sessions. Desktop layouts show Sessions as tabs. Narrow layouts place Agent and Session navigation in a focus-managed drawer.

A pinned Session is always open: it leads Open sessions and the tab strip however old it is, and never appears in History. Closing a pinned tab removes only the tab; its Open sessions row stays, and the tab returns the next time the Session is active. The pin is stored by the runtime, not the browser.

A Session that came from another platform (Buzz, WhatsApp, Slack, Telegram, Discord, or email) shows that platform's icon on its tab and History row, where the runtime reports it (Hermes and OpenClaw).

Routes use `/{agentId}/{sessionId}`. The `/en/` and `/he/` path prefixes are accepted and stripped, so bookmarked or shared locale-prefixed URLs resolve to the same route. Opening a compact route preserves the locally selected English or Hebrew preference. If an Agent or Session no longer exists, AOS refuses to navigate to stale provider data.

Creating a Session always creates it for the selected Agent. Provider events remain attached to their originating Agent and Session even if you navigate elsewhere while work is running.

## Send and control work

Use the composer to send messages and attachments supported by the runtime. AOS
displays streaming state and provider questions or approvals in the
conversation. Stop acts on the selected native run when the runtime exposes
that operation.

With a desktop keyboard, `Enter` submits and `Shift+Enter` inserts a newline.
On a touch-primary phone or tablet, Return inserts a newline; use the visible
Send button to submit. `Command/Ctrl+Enter` also submits on every platform.
When the Session is idle, submission sends immediately and no queue is shown.
While a run is active, submission adds a follow-up to the queue and
`Command/Ctrl+Shift+Enter` steers the active turn when the runtime exposes
text-only steering. Attachments always queue. Waiting for a question or
approval is not an active model turn, so new messages queue and the Steer
action is unavailable.

Queued messages appear in a tray docked above the composer. When the turn
ends, the whole queue is sent as one message, its texts joined in queue order.
Reorder rows by dragging them, or with `Alt+Up` and `Alt+Down` on a focused
row. A queued row can be steered or removed individually without changing the
order of the remaining rows.

Queued messages stay with their Session. Stop parks queued follow-ups until the
next explicit send. Editing the queue (Esc, Up from an empty composer, or
double-click or Enter on a queued message) takes all of it into the composer as
one draft; a draft you had written returns once that edit is sent or cleared. Switching away detaches or parks browser work according to
the runtime adapter; it never transfers a queue to another Agent.

## Follow runtime notices and reconnects

Hermes reports goal, loop, heartbeat, and background-process status while it
works; AOS shows each as a short notice line in the conversation, labelled by
kind. Notices are live only: they are not stored in history, so they do not
reappear after a reload.

If the connection to the gateway drops, the conversation stays on screen and a
"Reconnecting to AOS…" notice appears once the outage has lasted a few
seconds. It clears when every resumed Session has rejoined; "The AOS server is
full. Reconnecting shortly." means the gateway refused the connection for
capacity.

## Read Plans, Todos, and Subagents

- A **Plan** belongs to the assistant message that produced it. Inspect it with that message.
- **Todos** describe work in the current Session. Changing Sessions changes the Todo list.
- A **Subagent** is a nested delegated run, not a primary Agent and not an item in the Agent-management catalog.

## Open published Artifacts

An Agent shows a file with `present_artifact` from the AOS UI tools MCP server, passing an absolute path. A card appears in the conversation. It renders:

- **PDFs** as wide as the card, with selectable, findable text, keyboard reading (the arrow, Page Up/Down, and Space keys scroll the page and turn it at its edge; Home and End jump to the first and last page), and a sidebar of the outline and pages that the Sidebar control opens
- **Images**, fitted to the card
- **Plain text**
- **Agent-written HTML** with its own scripts, in a sandboxed frame with an opaque origin that reaches no network and loads no outside or relative files, beside its source highlighted as HTML
- **Anything else** as "No preview"

PDFs and images zoom with a pinch, Ctrl and the wheel or a trackpad pinch, the + and - keys (0 fits again), or the zoom controls; zoomed in, they pan by scrolling. Agent HTML zooms with Ctrl and the wheel or a trackpad pinch over its frame.

The card's controls are Refresh, Download, Full screen, Open in new tab, and pip, on one row with the preview's own controls; in the side panel and in full screen, whose header names the file, the view does not repeat the name. Open in new tab appears only for a PDF, an image, audio, or video, which the browser shows itself; any other file opens there as its plain text, so read it in the card, the side panel, or full screen. Esc leaves full screen for where the view was.

A file over its kind's preview limit (64 MiB for a PDF or an image, 25 MiB for HTML, 2 MiB for text) shows Download, and Open in new tab where the browser shows that kind, instead of a preview.

The tool's description tells the Agent to call it again after each change so the card shows the latest version.

**pip** moves the view into the side panel beside the conversation, or into a drawer over the conversation on phones. The message shows a short placeholder with a control that brings the view back. Moving the view reloads it, so a PDF reopens at its first page. Only one view is in pip at a time, within a Session. Close the panel, press Escape, or use the view's own inline control to return it.

The gateway serves the file; the `aos-ui` MCP server never opens it. The page receives a signed address that is valid for about ten minutes and renewed while the card is open. The address serves only the path the tool call named. Which paths may be served is governed by the `mcpApps.files` folder rules; see [Configuration](configuration.md) and [MCP Apps](mcp-apps.md).

**What can prevent a file from loading.** Each failure logs `app_file.refused` or `app_file.unavailable` in the gateway log. Common reasons:

- The tool's MCP server is not in `mcpApps.files.servers`, which defaults to `["aos-ui"]`.
- The runtime cannot read files (OpenCode, and OpenClaw for sandboxed or remote Sessions or guests).
- No folder is configured to serve from.
- The path is outside the folder rules or matches the built-in deny list (credential files and keys).
- The file is missing.

Hermes reads through its dashboard file API. OpenClaw reads through its Control UI media route. OpenCode cannot yet serve files; the card shows "Can't reach this file".

An Artifact from a `MEDIA:` line (Hermes and OpenClaw) or a trusted native delivery tool such as Hermes text-to-speech appears in the conversation as an inline image, audio, or video, or as a download link for other types. Paths mentioned in prose are not published.

## Use MCP Apps

When an Agent calls a tool whose MCP server declares an App view, such as the AOS UI charts, maps, and stats, the view appears in the conversation, usually as soon as the call starts, and receives the call's result once it settles. It shows a loading state while the view opens, and "The app could not be shown." when the view cannot be opened. The call's request and result stay available beneath it in the compact "Used" row.

An App may ask to fill the viewport, under a header that names it; close it with the header's **Exit full screen** control, which takes focus, or with Esc while focus is outside the App. An App may send a text message into the same conversation on your behalf and may open `https` links in a new tab. It cannot navigate the workspace, open pop-ups, or submit forms. Which servers provide Apps is set in the runtime's own MCP configuration; see [MCP Apps](mcp-apps.md).

## Rename, pin, archive, or delete a Session

Open the "…" menu on a Session row or at the top of the conversation, or right-click or long-press a Session tab or History row, to rename, pin, archive, or delete the Session. Hermes, OpenClaw, and OpenCode all perform these actions; an action the runtime does not declare stays in the menu, disabled, as "Unavailable for this runtime". Delete asks for confirmation and cannot be undone. Closing a tab offers a brief **Undo**.

Right-click or long-press a message for its own menu: **Copy** on every message; **Export as Markdown** and, when voice is configured, read-aloud on an assistant message; and, where the runtime supports editing, **Retry response** on an assistant message or **Edit message** on your own. On a touch device, **Select text** lets the next press select text in that message instead of opening the menu.

## Select a model and view context usage

When the runtime and deployment support it, the composer shows a model selector and a context-window gauge. Select a model to change the active Session's model; the gauge updates as the window fills. Reasoning-effort selection is available where the runtime reports a reasoning ladder; it is unavailable for OpenCode.

## Search conversations

Use the conversation search control to find messages in the current Session. Results highlight matching text inline.

## Use slash-command suggestions

Type `/` in the composer to see available slash commands from the runtime. Suggestions are presentation only; the runtime handles routing. Guests get no slash commands: the guest composer shows none, and the guest listener refuses a guest message that starts with `/`.

## Answer a question or free-text "Other"

When the runtime asks a multiple-choice question, the options appear in the conversation. Choose one of the offered answers or select **Other** to type a free-text reply.

## Edit or regenerate a message

For runtimes that support it (Hermes), you can edit a submitted user message or regenerate the last assistant response from the conversation controls. Editing truncates the conversation at that point and resubmits.

## Start a new Agent

Use the **New Agent** control to open a Session with the creator Agent when exactly one creator is configured in the runtime. This is available only when the provider marks one Agent as the creator. The creator interviews you with the `aos-agent-creator` skill, confirms the definition, and creates the Agent with the harness's own means. The **New Agent** draft row becomes the new Agent once the harness lists it; if the run ends without one, it stays an ordinary creator Session.

## Manage Agent visibility

Open **Manage Agents** to inspect the provider catalog. A visible, selectable Agent appears in the workspace roster. A hidden Agent remains provider-owned but is not selectable in normal navigation.

Each Agent shows a generated robot icon. The workspace saves the icon it shows to the runtime, so every browser draws the same one: Hermes stores it in the profile, OpenClaw in an Agent's own config entry, and OpenCode only reads an icon written by hand in the Agent file. Hiding an Agent frees its icon. A running Agent's icon blinks; an Agent waiting for you looks around and hops, and under reduced motion it holds still, looking aside.

Visibility edits are available only when the runtime exposes a native mutation and marks the entry editable. AOS confirms the provider result before updating the roster. Hermes can update native profile visibility; OpenClaw and OpenCode currently report their catalogs as read-only. Fixture changes are temporary.

The dedicated creator identity and provider/system definitions never appear in normal management. Agent creation is available only when exactly one native Agent is marked as the creator. The public fixture intentionally omits it. See the [runtime matrix](runtime-capabilities.md) for current support.

## Use Activity and notifications

Activity is the browser inbox for run completion, failures, questions, permissions, and Agent-creation outcomes. Provider state remains authoritative for the underlying work.

Each Session navigation row shows at most one status dot at a time. A state that needs your attention (waiting for input, error) outranks unread, which outranks an in-progress run with nothing pending:

- **Orange (waiting):** the Session is waiting for your input. Clears when you respond or the run finishes.
- **Red (failed):** the run failed.
- **Green (unread):** the Session has content you have not yet seen. Clears when you view the Session in a focused window. Browsing the Activity drawer does not mark anything read.
- **Blue (running):** a run is in progress and nothing else is pending. The dot breathes, and holds steady under reduced motion.

The selected visible and focused Session is already considered read, so its completion does not generate a separate alert. Events from other Sessions add unread markers and an in-app notice.

### Notification preferences and the one-time ask

Notification preferences are on by default. The first time the browser receives a message from the operator, an inline card appears in the conversation offering to enable OS notifications. Tap **Turn on** to grant permission; tap **Not now** to opt out durably. You can revisit both choices in Activity settings at any time.

There is no modal or load-time permission prompt. The ask appears only once in a conversation, only after real operator traffic, and only if permission has not already been granted or denied.

### Categories and sound

Notifications are grouped into three categories: **input requests** (questions and permissions), **failures**, and **completions**. A short in-tab audio cue plays for input requests and failures — not completions — and only when the event is in a Session other than the one currently on screen. OS notifications use the OS default sound and follow OS Do Not Disturb; the in-tab cue is page audio and does not. Sound is never the only channel; all states remain visible in Activity.

### Burst coalescing

Rapid events are coalesced per category into one notification: a 3-second window for input requests, 5 seconds for failures, 20 seconds for completions. The resulting notification carries a count ("3 Agents need input") rather than repeating for each event. Tapping it opens the owning Session when there is exactly one; otherwise it opens the workspace.

### OS notifications without an open tab (Web Push)

When the gateway is configured for Web Push, a device that has notifications turned on receives OS notifications even with no AOS tab open, via a service worker. When at least one tab is open and active on that device, the tab handles delivery and no OS alert is raised.

Cross-device suppression: push is not sent while you are present on any device — defined as a foreground AOS tab that has been active within the last three minutes, with a 60-second heartbeat. After you stop being present, a backgrounded or idle tab holds notifications for 60 seconds; a closed workspace holds them for about 2 seconds, long enough for a reload to reconnect. A Session on screen never alerts.

If the deployment does not configure Web Push, or if the origin is not HTTPS, notifications require at least one open AOS tab. Activity settings reflect the current state.

**Platform notes.** On iPhone and iPad, Web Push works only in installed web apps: tap **Share → Add to Home Screen** first. Safari on macOS shows the app icon and does not collapse multiple notifications. Firefox ESR is supported via the classic service worker API. On Chromium browsers an **Install AOS** button appears; other browsers show an installation hint.

### Privacy

Notification payloads and OS text contain no Agent name, Session name, conversation content, tool content, question, permission, or error details — only a category, a count, opaque identifiers, a timestamp, and locale. Multiple tabs elect one delivery tab so no peer repeats an alert. Guest sessions receive no notifications.

Activity history lives in the gateway's in-memory feed; it does not survive a gateway restart by design. Browser and operating-system policies may delay or suppress delivery; Activity remains the place to check.

## Change language and appearance

AOS supports English LTR and Hebrew RTL. Language, appearance, keyboard settings, inspector state, and manually opened recent tabs are local browser preferences; they do not change native runtime state.

## Optional workflows

- [Configure voice](chat-voice.md)
- [Create a restricted guest invitation](invite-chat.md)
- [Troubleshoot AOS](troubleshooting.md)
