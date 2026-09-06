# Agent visibility management

`WorkspaceAdapter.listAgents()` is the selectable, visible workspace roster,
including selectable Builder drafts. Optional `listAgentCatalog()` returns
ordinary primary Agents as `{ summary, visibility, selectable, editable }`.
Hidden Agents appear only in the catalog. Builder drafts, Agent Builder,
native/system Agents, and subagent-only definitions do not appear there.
`updateAgentVisibility(id, "visible" | "hidden")` is optional; capabilities
`agentCatalog` and `agentVisibilityUpdates` derive from method availability.

## OpenCode deployments

The AOS launcher runs a narrow management HTTP service beside OpenCode,
using the same worktree and allowed CORS origins. It defaults to port `4097`
and follows the OpenCode host binding. Its lifecycle ends with the provider
child process. Compose includes the service in the OpenCode container and
publishes both ports on loopback. The web container needs only a
browser-reachable `AOS_UI_OPENCODE_MANAGEMENT_URL`, not filesystem access.
Without that URL, OpenCode catalog entries remain read-only.
Management URLs may include a path prefix; trailing slashes are removed.
Credentials, query strings, and fragments are unsupported and rejected.

The service supports `PATCH /agents/:agentId/visibility` with an allowed
`Origin`, `Content-Type: application/json`, and a body containing only
`visibility` and `expectedVisibility`. Both values are `visible` or `hidden`.
`OPTIONS` handles the corresponding preflight; `GET /health` reports service
availability. No creation, deletion, prompt editing, or arbitrary-file API is
exposed. The port, like OpenCode itself, is unauthenticated and intended for
loopback or trusted private networks with explicitly configured origins.

An update must pass both provider catalog validation and on-disk checks. Only
`.opencode/agents/<validated-id>.md` primary/all definitions with
`aos_ui_managed: true` or a valid legacy `aos_ui_name` are editable. Reserved
IDs, native definitions, symlinks, hard links, malformed/ambiguous frontmatter,
flow-style frontmatter mappings, and definitions exceeding 64 KiB are rejected.
The resulting frontmatter is validated before replacement. A managed marker is
an ownership convention, not protection against a trusted user editing their own
files.

The writer changes only the `hidden` scalar, preserving other frontmatter,
comments, line endings, and the prompt. It uses an exclusive worktree lock,
checks the original file's identity and content immediately before an atomic
rename, and writes replacement files with mode `0600`. Concurrent service
requests and detected external edits fail instead of overwriting changes.
After a process crash, a leftover `.opencode/agents/.aos-ui-visibility.lock`
deliberately blocks updates; remove that exact lock only after confirming no
management write is running. External tools that ignore the advisory lock
must avoid editing the same definition during a visibility update.

## Reload and failure semantics

OpenCode 1.18.27 caches Agent files and does not discover frontmatter changes
until its instance reloads. Its SDK project config update writes `config.json`,
which the project loader does not read; this service therefore edits the
managed definition directly.

Before writing, the service rejects busy/retrying Sessions and pending
questions/permissions. It checks again after persistence and reloads only if
still idle. If activity appears after saving, it returns retryable
`pending-reload`; the catalog continues to reflect the running provider's
current visibility. Repeat the same action after activity ends to apply the
saved value. A repeated request always attempts reload even when the file
already contains the requested value.

Success requires `app.agents()` to confirm the requested visibility after
reload. The client adapter independently reads the authoritative catalog and
publishes invalidation on success or failure. Configuration overrides that
prevent the requested value from taking effect therefore produce a visible
error. A failed reload/readback may leave the requested value on disk; retry
after resolving the provider issue. Hiding does not delete Agent definitions,
archive Sessions, or change their ownership.

The adapter uses the existing local reload barrier to prevent sends from its
own scoped client during the operation. OpenCode provides no atomic
idle-and-reload operation: an independent client can start a run between the
last activity check and reload. This is the same provider constraint as Builder
activation; a universal proxy for all provider clients is outside this service.

## AG-UI and fixtures

Existing AG-UI `GET /agents` payloads remain supported. Hosts may add optional
`visibility`, `selectable`, and `editable` fields. Missing values mean visible,
selectable, and read-only. The HTTP transport's explicit
`supportsVisibilityUpdates: true` option enables
`PATCH /agents/:agentId/visibility` with `{ visibility }`; custom transports
may supply the same optional operation. The workspace requires per-entry
editability and verifies the host's catalog after updating. Without an update
operation all entries are read-only, regardless of metadata.

Fixture mode supplies five visible Agents and hidden Sable. It supports
deterministic visibility changes and catalog notifications; changes last only
for that fixture workspace instance.
