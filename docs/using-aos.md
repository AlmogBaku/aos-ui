# Use AOS

AOS is organized around provider-owned Agents and Sessions. The selected runtime remains authoritative; the browser projects its state and keeps only local view preferences and notification delivery state.

## Choose an Agent and Session

Select an Agent from the roster, then open one of its Sessions. Desktop layouts show Sessions as tabs. Narrow layouts place Agent and Session navigation in a focus-managed drawer.

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
While a run is active, submission adds a FIFO follow-up and
`Command/Ctrl+Shift+Enter` steers the active turn when the runtime exposes
text-only steering. Attachments always queue. A queued row can be steered
individually without changing the order of the remaining rows. Waiting for a
question or approval is not an active model turn, so new messages queue and the
Steer action is unavailable.

Queued messages stay with their Session. Stop parks queued follow-ups until the
next explicit send. Switching away detaches or parks browser work according to
the runtime adapter; it never transfers a queue to another Agent.

## Read Plans, Todos, and Subagents

- A **Plan** belongs to the assistant message that produced it. Inspect it with that message.
- **Todos** describe work in the current Session. Changing Sessions changes the Todo list.
- A **Subagent** is a nested delegated run, not a primary Agent and not an item in the Agent-management catalog.

## Open published Artifacts

An Artifact appears only after an Agent explicitly publishes it: by calling the `present_artifact` tool from the AOS UI tools MCP server with an absolute file path, by writing a `MEDIA:/absolute/path` line where the runtime supports it (Hermes and OpenClaw), or through a trusted provider-native delivery receipt, such as a successful Hermes text-to-speech result. Ordinary files and paths mentioned in prose are not exposed. A relative or traversing path, a credential file such as `.env` or `auth.json`, and a file over 25 MiB cannot be published.

AOS resolves the Artifact through the selected runtime and offers a read-only preview or download. HTML opens in an isolated frame with a fixed content-security policy and an inspectable Source view. Operators may allow selected HTTPS asset origins through public configuration; see [Configuration](configuration.md#artifact-html-assets). Inline image, audio, and video Artifacts appear directly in the conversation.

## Use MCP Apps

When an Agent calls a tool whose MCP server declares an App view, such as the AOS UI charts, maps, and stats, the view appears in the conversation, usually as soon as the call starts, and receives the call's result once it settles. It shows a loading state while the view opens, and "The app could not be shown." when the view cannot be opened. The call's request and result stay available beneath it in the compact "Used" row.

An App may ask to fill the viewport; close it with the **Exit full screen** control, or with Esc while focus is outside the App. An App may send a text message into the same conversation on your behalf and may open `https` links in a new tab. It cannot navigate the workspace, open pop-ups, or submit forms. Which servers provide Apps is set in the runtime's own MCP configuration; see [MCP Apps](mcp-apps.md).

## Rename, archive, or delete a Session

Open the "…" menu on a Session row or at the top of the conversation to rename, archive, or delete the Session. These actions are available only when the selected runtime supports them; they are Hermes-only in V1. Closing the tab after a delete offers a brief undo.

## Select a model and view context usage

When the runtime and deployment support it, the composer shows a model selector and a context-window gauge. Select a model to change the active Session's model; the gauge updates as the window fills. Reasoning-effort selection is available where the runtime reports a reasoning ladder; it is unavailable for OpenCode.

## Search conversations

Use the conversation search control to find messages in the current Session. Results highlight matching text inline.

## Use slash-command suggestions

Type `/` in the composer to see available slash commands from the runtime. Suggestions are presentation only; the runtime handles routing. They are hidden in the guest composer unless `AOS_UI_COMPOSER_SLASH_COMMANDS_ENABLED=true` is set on the proxy.

## Answer a question or free-text "Other"

When the runtime asks a multiple-choice question, the options appear in the conversation. Choose one of the offered answers or select **Other** to type a free-text reply.

## Edit or regenerate a message

For runtimes that support it (Hermes), you can edit a submitted user message or regenerate the last assistant response from the conversation controls. Editing truncates the conversation at that point and resubmits.

## Start a new Agent

Use the **New Agent** control to open a Session with the creator Agent when exactly one creator is configured in the runtime. This is available only when the provider marks one Agent as the creator. The creator interviews you with the `aos-agent-creator` skill, confirms the definition, and creates the Agent with the harness's own means. The **New Agent** draft row becomes the new Agent once the harness lists it; if the run ends without one, it stays an ordinary creator Session.

## Manage Agent visibility

Open **Manage Agents** to inspect the provider catalog. A visible, selectable Agent appears in the workspace roster. A hidden Agent remains provider-owned but is not selectable in normal navigation.

Visibility edits are available only when the runtime exposes a native mutation and marks the entry editable. AOS confirms the provider result before updating the roster. Hermes can update native profile visibility; OpenClaw and OpenCode currently report their catalogs as read-only. Fixture changes are temporary.

The dedicated creator identity and provider/system definitions never appear in normal management. Agent creation is available only when exactly one native Agent is marked as the creator. The public fixture intentionally omits it. See the [runtime matrix](runtime-capabilities.md) for current support.

## Use Activity and notifications

Activity is the browser inbox for run completion, failures, questions, permissions, and Agent-creation outcomes. Provider state remains authoritative for the underlying work.

Each Session navigation row shows at most one status dot at a time. A state that needs your attention (waiting for input, error) outranks unread, which outranks an in-progress run with nothing pending:

- **Blue (waiting):** the Session is waiting for your input. Clears when you respond or the run finishes.
- **Green (unread):** the Session has content you have not yet seen. Clears when you view the Session in a focused window. Browsing the Activity drawer does not mark anything read.

The selected visible and focused Session is already considered read, so its completion does not generate a separate alert. Events from other Sessions add unread markers and an in-app notice.

### Notification preferences and the one-time ask

Notification preferences are on by default. The first time the browser receives a message from the operator, an inline card appears in the conversation offering to enable OS notifications. Tap **Turn on** to grant permission; tap **Not now** to opt out durably. You can revisit both choices in Activity settings at any time.

There is no modal or load-time permission prompt. The ask appears only once in a conversation, only after real operator traffic, and only if permission has not already been granted or denied.

### Categories and sound

Notifications are grouped into three categories: **input requests** (questions and permissions), **failures**, and **completions**. A short in-tab audio cue plays for input requests and failures — not completions — and only when the event is in a Session other than the one currently on screen. OS notifications use the OS default sound and follow OS Do Not Disturb; the in-tab cue is page audio and does not. Sound is never the only channel; all states remain visible in Activity.

### Burst coalescing

Rapid events are coalesced per category into one notification: a 3-second window for input requests, 5 seconds for failures, 20 seconds for completions. The resulting notification carries a count ("3 Agents need input") rather than repeating for each event. Tapping it opens the owning Session when there is exactly one; otherwise it opens the workspace.

### OS notifications without an open tab (Web Push)

When the proxy is configured for Web Push, a device that has notifications turned on receives OS notifications even with no AOS tab open, via a service worker. When at least one tab is open and active on that device, the tab handles delivery and no OS alert is raised.

Cross-device suppression: push is not sent while you are present on any device — defined as a foreground AOS tab that has been active within the last three minutes, with a 60-second heartbeat. After you stop being present, a backgrounded or idle tab holds notifications for 60 seconds; a closed workspace holds them for about 2 seconds, long enough for a reload to reconnect. A Session on screen never alerts.

If the deployment does not configure Web Push, or if the origin is not HTTPS, notifications require at least one open AOS tab. Activity settings reflect the current state.

**Platform notes.** On iPhone and iPad, Web Push works only in installed web apps: tap **Share → Add to Home Screen** first. Safari on macOS shows the app icon and does not collapse multiple notifications. Firefox ESR is supported via the classic service worker API. On Chromium browsers an **Install AOS** button appears; other browsers show an installation hint.

### Privacy

Notification payloads and OS text contain no Agent name, Session name, conversation content, tool content, question, permission, or error details — only a category, a count, opaque identifiers, a timestamp, and locale. Multiple tabs elect one delivery tab so no peer repeats an alert. Guest sessions receive no notifications.

Activity history lives in the proxy's in-memory feed; it does not survive a proxy restart by design. Browser and operating-system policies may delay or suppress delivery; Activity remains the place to check.

## Change language and appearance

AOS supports English LTR and Hebrew RTL. Language, appearance, keyboard settings, inspector state, and manually opened recent tabs are local browser preferences; they do not change native runtime state.

## Optional workflows

- [Configure voice](chat-voice.md)
- [Create a restricted guest invitation](invite-chat.md)
- [Troubleshoot AOS](troubleshooting.md)
