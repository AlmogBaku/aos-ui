# Use AOS

AOS is organized around provider-owned Agents and Sessions. The selected runtime remains authoritative; the browser projects its state and keeps only local view preferences and notification delivery state.

## Choose an Agent and Session

Select an Agent from the roster, then open one of its Sessions. Desktop layouts show Sessions as tabs. Narrow layouts place Agent and Session navigation in a focus-managed drawer.

Routes use `/{agentId}/{sessionId}`. Opening a compact route preserves the locally selected English or Hebrew preference. If an Agent or Session no longer exists, AOS refuses to navigate to stale provider data.

Creating a Session always creates it for the selected Agent. Provider events remain attached to their originating Agent and Session even if you navigate elsewhere while work is running.

## Send and control work

Use the composer to send messages and attachments supported by the runtime. AOS
displays streaming state and provider questions or approvals in the
conversation. Stop acts on the selected native run when the runtime exposes
that operation.

When the Session is idle, `Enter` sends immediately and no queue is shown.
While a run is active, `Enter` adds a FIFO follow-up and
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

An Artifact appears only after an Agent explicitly publishes it. Ordinary files in a runtime worktree are not automatically exposed.

AOS resolves the Artifact through the selected runtime and offers a read-only preview or download. HTML opens in an isolated frame with a fixed content-security policy and an inspectable Source view. Operators may allow selected HTTPS asset origins through public configuration; see [Configuration](configuration.md#artifact-html-assets).

## Manage Agent visibility

Open **Manage Agents** to inspect the provider catalog. A visible, selectable Agent appears in the workspace roster. A hidden Agent remains provider-owned but is not selectable in normal navigation.

Visibility edits are available only when the runtime exposes a native mutation and marks the entry editable. AOS confirms the provider result before updating the roster. OpenCode currently reports its catalog as read-only; Hermes can update native profile visibility. Fixture changes are temporary, and generic AG-UI support depends on the workspace service.

The dedicated creator identity and provider/system definitions never appear in normal management. Agent creation is available only when exactly one native Agent is marked as the creator. The public fixture intentionally omits it. See the [runtime matrix](runtime-capabilities.md) for current support.

## Use Activity and notifications

Activity is the persistent browser inbox for run completion, failures, questions, permissions, and Agent-creation outcomes. Provider state remains authoritative for the underlying work.

The selected visible and focused Session is already considered read, so its completion does not generate a separate alert. Events from another Session add unread markers and an in-app notice. A hidden tab or an unfocused browser window can show a generic operating-system notification after you enable notifications in Activity settings and grant browser permission.

> [!IMPORTANT]
> Browser notifications require at least one loaded AOS tab. There is no service worker, Web Push service, email delivery, or closed-app delivery.

Notification text contains no Agent name, Session name, conversation content, tool content, question, permission, or error details. Multiple tabs synchronize read state and elect one delivery tab. Browser and operating-system policies may delay or suppress delivery; Activity remains the place to check.

## Change language and appearance

AOS supports English LTR and Hebrew RTL. Language, appearance, keyboard settings, inspector state, and manually opened recent tabs are local browser preferences; they do not change native runtime state.

## Optional workflows

- [Configure Hermes voice](chat-voice.md)
- [Create a restricted guest invitation](invite-chat.md)
- [Troubleshoot AOS](troubleshooting.md)
