# Hermes integration interfaces at v2026.8.31

Status: superseded implementation-planning research, not an implementation
specification. The implemented native-gateway architecture and tested revision are
documented in the root README and `integrations/hermes/README.md`; they replace the
bridge and registry proposal recorded below. All historical claims below are pinned
to Hermes tag `v2026.8.31` (the `v0.21.0` release, commit
`29112bef099274229cadff79cdff7bf7b99c4b77`).

## Decisions the release supports

1. Author the AOS presentation harness and `start_session` under the AOS source
   monorepo's `integrations/hermes` seam, and package that seam as a **standalone
   native Hermes plugin** (`plugin.yaml` plus `register(ctx)`). The released installer
   can install a plugin subdirectory from a Git repository; a separately published
   repository/artifact is therefore optional, not a source-ownership requirement.
   Native plugins can register both model-visible tools and a bounded, cache-safe
   system-prompt section. No Hermes fork or native AG-UI patch is needed.
2. Install that plugin separately into every participating profile, pinned to an
   immutable full commit SHA. Plugin installation is profile-scoped when invoked as
   `hermes -p <profile> plugins ...`.
3. Have `start_session` call an AOS-owned bridge with a narrowly scoped bridge
   credential. The bridge, not the model or browser, owns each profile's
   `API_SERVER_KEY`, creates the durable API Session, submits the first Run, and
   persists the correlation tuple before the tool reports success.
4. Create product Agents as fresh profiles or from a reviewed profile distribution.
   Never clone the privileged creator profile: Hermes' config clone explicitly copies
   `.env` and therefore copies credentials.
5. Treat the Dashboard's machine-wide profile REST API as an optional administrative
   integration. Its released authentication is designed primarily for browser/desktop
   sessions; there is no general bearer token that authorizes `/api/profiles`.
6. Continue an AOS-owned Session with `POST /v1/runs` and the same `session_id`.
   For a discovered CLI/cron/channel Session whose live owner cannot be proven, create
   a new AOS-controlled Session and persist a bounded source snapshot as its first user
   turn. Do not use native fork by default: released fork ends the source Session as
   `branched`.

## Native plugin contract

### Package and installation

The official third-party-product policy is a standalone plugin installed under the
active profile's `$HERMES_HOME/plugins`, not a contribution to Hermes core. Hermes can
clone a plugin from a repository root or resolve a contained plugin directory. This
means the authored source can remain at `integrations/hermes` in the AOS monorepo and
be installed from an `owner/repo/path/to/plugin`, a `.git/path/to/plugin` URL, or an
explicit `<git-url>#path/to/plugin` identifier. The released install sequence is:

```bash
hermes -p <profile> plugins install <owner/repository/integrations/hermes> \
  --ref <full-40-character-commit-sha> --no-enable
hermes -p <profile> plugins doctor <plugin-id> --ci
hermes -p <profile> plugins enable <plugin-id>
```

For an unattended, already-reviewed install, `--enable` may replace `--no-enable`
plus the final command. New third-party plugins are disabled unless explicitly
enabled. `--ref` accepts only a full immutable commit; Hermes checks out detached,
verifies `HEAD`, records provenance, and refuses to move the pin during ordinary
updates. `plugins doctor` validates discovery and registration but does not sandbox
the plugin. A native plugin runs in-process with the Hermes user's authority.

Offline/local options at this tag are bounded:

- `hermes plugins install` does **not** accept a plain source directory or archive. It
  always resolves a Git source. It does accept a `file://` Git URL (with a warning),
  including `file:///path/to/aos-ui#integrations/hermes`, so a committed local clone
  can be installed and pinned without GitHub/network access.
- The user guide also supports directly dropping a plugin directory under
  `$HERMES_HOME/plugins/<name>/`; this works for development/offline packaging, but it
  bypasses the install command's Git revision record and pre-install scan. The
  deployment must supply its own checksum/provenance verification before copying.
- NixOS has a first-class declarative `extraPlugins` source-tree path.

The minimum useful manifest is:

```yaml
name: aos-integration
version: 1.0.0
description: AOS session handoff and rich-presentation tools
provides_tools:
  - aos_start_session
  - aos_present
requires_env:
  - name: AOS_HERMES_BRIDGE_TOKEN
    description: Narrow credential for the AOS Hermes bridge
    secret: true
```

`requires_env` gates loading. During interactive installation Hermes prompts for
missing values and saves them to the active profile's `.env`; an unattended installer
must provision them separately. Do not put a Hermes `API_SERVER_KEY` in a tool schema,
tool result, plugin config, distribution, or model-visible prompt.

Compatibility limit: although the pinned developer guide describes an additive
`manifest_version: 2`, the pinned CLI install code sets
`_SUPPORTED_MANIFEST_VERSION = 1` and rejects any larger declared value. The safe
v2026.8.31 manifest therefore omits `manifest_version` (legacy v1) as above. Treat the
guide/installer mismatch as an upstream contradiction and keep an install smoke test
against the pinned binary.

Evidence: [Plugin developer guide (Nous Research, v2026.8.31)](https://github.com/NousResearch/hermes-agent/blob/v2026.8.31/website/docs/developer-guide/plugins/index.md),
[plugin user guide](https://github.com/NousResearch/hermes-agent/blob/v2026.8.31/website/docs/user-guide/features/plugins.md), and
[`_plugins_dir` / per-home plugin-manager implementation](https://github.com/NousResearch/hermes-agent/blob/v2026.8.31/hermes_cli/plugins_cmd.py).
Confidence: high.

### Tool registration and handler semantics

`register(ctx)` is called once at startup. Register a tool with:

```python
ctx.register_tool(
    name="aos_start_session",
    toolset="aos",
    schema=START_SESSION_SCHEMA,
    handler=start_session,
)
```

The schema is OpenAI-style JSON Schema (`name`, `description`, and an object
`parameters`). A handler's documented shape is
`def handler(args: dict, **kwargs) -> str`; it should catch failures and always return
a JSON string. `**kwargs` is required for additive compatibility. Registration makes
the tool immediately model-visible. No privileged `tools.override` capability is
needed when AOS uses unique names rather than replacing built-ins.

The start handler should send only an internally generated idempotency/correlation
key, target profile, initial user request, and allowed metadata to the bridge. The
released registry dispatch passes `task_id`, `session_id`, and `user_task` in handler
`**kwargs`; it does **not** pass `tool_call_id`, `turn_id`, or `api_request_id` to an
ordinary registered tool handler. Those richer IDs are present on lifecycle hooks and
tool events, but the implementation must not assume the start handler can read them.

Generate one `start_request_id` inside the handler before the first outbound attempt
and reuse it across that handler's HTTP retries. Return it in the tool result. The AOS
adapter can then correlate the Hermes tool-call event ID with the returned
`start_request_id`; do not ask the model to invent an idempotency key. The bridge
should:

1. resolve the configured engine instance and profile;
2. create a Session with `POST /p/{profile}/api/sessions`;
3. submit `POST /p/{profile}/v1/runs` with the same `session_id` and a deterministic
   `Idempotency-Key`;
4. durably store `{engineInstanceId, profile, sessionId, runId, initiatingSessionId,
startRequestId}` before returning success.

If a whole new model tool call is issued after an ambiguous result, it is a new handler
execution and has no released stable tool-call ID available inside the handler. The
bridge may offer a bounded duplicate-intent recovery lookup, but must not collapse all
identical requests from one Session: repeated identical requests can be legitimate.

Hermes tools execute server-side, so presentation tools should return compact,
validated JSON. The AOS adapter maps Hermes tool lifecycle events and results to its
rich UI; no browser-side execution or native Hermes AG-UI transport is required.

Evidence: [native plugin tool schemas, handlers, and registration](https://github.com/NousResearch/hermes-agent/blob/v2026.8.31/website/docs/developer-guide/plugins/index.md),
[`model_tools.handle_function_call` dispatch kwargs](https://github.com/NousResearch/hermes-agent/blob/v2026.8.31/model_tools.py), and
[`tools.registry.dispatch`](https://github.com/NousResearch/hermes-agent/blob/v2026.8.31/tools/registry.py).
Confidence: high. Open limit: the docs promise additive native-plugin compatibility,
not a globally versioned ABI; keep a pinned-version contract test.

### Always-on presentation instructions

The release has an exact native prompt hook:

```python
ctx.register_system_prompt_section(
    "aos.presentation",
    PRESENTATION_INSTRUCTIONS,
    position="after_memory",
    max_chars=4000,
)
```

The rules are material to the plan:

- the ID is global, stable, lowercase, 1-128 characters, and may contain `.`, `_`,
  and `-`; duplicates are rejected;
- `after_memory` is the only placement anchor;
- content may be a string or a callable receiving a read-only mapping with
  `session_id`, `model`, `provider`, `platform`, `profile_name`, and `cwd`;
- the per-section cap is 4,000 characters; all plugin sections together are capped at
  8,000 characters and 32 sections;
- accepted bytes are named/audited in the prompt and frozen into the durable Session
  prompt. Resume restores them verbatim. A later explicit prompt invalidation or
  compression rebuild can re-render the section;
- invalid, oversized, non-string, or raising sections are skipped with a warning,
  rather than failing the Session.

This is the correct released hook for stable AOS presentation guidance. A
`pre_llm_call` hook is different: it appends dynamic context to the current **user
message**, is not persisted, and is capped/spilled separately. Plugin-bundled Skills
are also not automatically listed in the system prompt, so they cannot guarantee that
the model loads the presentation instructions.

For AOS-initiated runs, `instructions` on `/v1/runs` remains useful for truly
turn-scoped detail, but it should not duplicate the stable plugin section.

Evidence: [cache-safe system prompt section contract](https://github.com/NousResearch/hermes-agent/blob/v2026.8.31/website/docs/user-guide/features/hooks.md),
[`PluginContext.register_system_prompt_section`](https://github.com/NousResearch/hermes-agent/blob/v2026.8.31/hermes_cli/plugins.py), and
[prompt assembly guide](https://github.com/NousResearch/hermes-agent/blob/v2026.8.31/website/docs/developer-guide/prompt-assembly.md).
Confidence: high.

## Profile creation and credential containment

### Official creation surfaces

Hermes v2026.8.31 exposes three relevant paths:

| Surface        | Released request                                                           | Suitable use                                                                                                                                        |
| -------------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| CLI            | `hermes profile create <name> --description <text> --no-alias`             | Preferred fixed-argv operation behind the privileged creator tool. Omit every clone flag.                                                           |
| Python library | `hermes_cli.profiles.create_profile(name, no_alias=True, description=...)` | Exact implementation behind CLI/Dashboard, but importing Hermes internals couples the external plugin more tightly than invoking the supported CLI. |
| Dashboard      | `POST /api/profiles` with `ProfileCreate`                                  | Optional human/admin flow when an authenticated Dashboard is deliberately integrated.                                                               |

A fresh create validates and canonicalizes the name, rejects `default` and existing
profiles, creates isolated profile directories, seeds an empty owner-only `.env`, a
default `SOUL.md`, model config, and (unless `--no-skills`) bundled Skills. The CLI
then seeds bundled Skills and can create a shell alias. Creation is not a security
sandbox: profiles isolate Hermes state through `HERMES_HOME`, while host tool
subprocesses normally retain the real OS `HOME` and its Git/SSH/cloud credentials.

`hermes profile create --clone` and `--clone-from` copy `config.yaml`, `.env`,
`SOUL.md`, installed Skills, and identity files. `--clone-all` copies more state.
Therefore the creator must never clone itself into an ordinary Agent.

Evidence: [profiles user guide](https://github.com/NousResearch/hermes-agent/blob/v2026.8.31/website/docs/user-guide/profiles.md),
[`create_profile`](https://github.com/NousResearch/hermes-agent/blob/v2026.8.31/hermes_cli/profiles.py), and
[profile CLI parser](https://github.com/NousResearch/hermes-agent/blob/v2026.8.31/hermes_cli/subcommands/profile.py).
Confidence: high.

### Reviewed profile distributions

For externally owned Agent content, the official product-shaped path is:

```bash
hermes profile install <allowlisted-distribution-url> \
  --name <validated-profile-name> --yes
hermes -p <validated-profile-name> plugins install \
  <allowlisted-source-repo/integrations/hermes> \
  --ref <full-plugin-commit-sha> --enable
```

The distribution installer hard-excludes `.env`, `auth.json`, Sessions, memories,
state databases, logs, workspaces, plans, caches, and `local/`. Its default authored
payload is `SOUL.md`, `config.yaml`, `mcp.json`, `skills/`, `cron/`, and
`distribution.yaml`. It creates `.env.EXAMPLE` from declared requirements; it does not
copy usable secrets. Cron definitions are not auto-scheduled.

Important limitation: unlike plugin installation, the released profile-distribution
CLI has no `--ref` flag and its `_git_clone` implementation clones depth-one `HEAD`.
An implementation docstring says a URL may contain `#<ref>`, but the released staging
code neither parses nor checks such a ref. Treat distributions as mutable/unpinned in
this release. For reproducibility, AOS should resolve and verify the repository commit
outside Hermes (or install from an already verified local staging directory) before
calling the installer. Do not claim Hermes itself pins the distribution.

Evidence: [profile distributions guide](https://github.com/NousResearch/hermes-agent/blob/v2026.8.31/website/docs/user-guide/profile-distributions.md),
[`profile_distribution.py`](https://github.com/NousResearch/hermes-agent/blob/v2026.8.31/hermes_cli/profile_distribution.py), and
[distribution CLI flags](https://github.com/NousResearch/hermes-agent/blob/v2026.8.31/hermes_cli/subcommands/profile.py).
Confidence: high. Contradiction: the module docstring advertises `#<ref>` while the
actual released clone path does not implement it.

### Safe creator flow

The smallest honest privileged creator is a narrowly scoped plugin tool, not general
terminal access:

1. validate the requested profile name against AOS policy and pass a fixed argv (no
   shell) to fresh-create or install one allowlisted, independently verified
   distribution;
2. never accept arbitrary repository URLs, clone sources, environment maps, plugin
   code, or shell fragments from model arguments;
3. install the AOS plugin into the child profile at a configured full commit SHA;
4. provision a **new child-specific** API-server key and bridge credential through an
   operator-owned secret path, never by copying the creator `.env` and never through
   model-visible arguments or results;
5. return `needs_credentials`/`needs_setup` until that provisioning succeeds; only
   then start or expose the child's gateway/API prefix;
6. redact absolute filesystem paths, subprocess output, and credentials from the tool
   result and audit the creator Session/tool-call ID.

Hermes provides an authenticated Dashboard `PUT /api/env` that validates env names and
writes a selected profile's `.env`, but it shares the Dashboard's browser-oriented
auth limitation below. There is no documented, general, non-interactive Dashboard
bearer credential for this route. If AOS does not supply a dedicated operator-side
secret provisioner, profile creation can safely produce only an uncredentialed Agent.

Also scrub the creator subprocess environment. Profile isolation changes
`HERMES_HOME`, not the OS user's `HOME`; global shell environment and normal CLI
credentials can otherwise remain available to child processes even though no secret
file was copied. `terminal.home_mode: profile` narrows tool CLI state, but does not by
itself replace deployment-level process/env isolation.

Confidence: high for the released boundaries; medium for the recommended external
secret-provisioning design because that mechanism belongs to AOS deployment policy,
not Hermes.

## Dashboard profile catalog and auth

The Dashboard is a machine-level management surface. Its default address is
`http://127.0.0.1:9119`; remote binding uses `--host 0.0.0.0 --port 9119` (normally
behind TLS/VPN/reverse proxy). Relevant routes are:

### `GET /api/profiles`

Response:

```json
{
  "profiles": [
    {
      "name": "researcher",
      "path": "/absolute/profile/path",
      "is_default": false,
      "model": "...",
      "provider": "...",
      "has_env": true,
      "skill_count": 12,
      "gateway_running": true,
      "description": "...",
      "description_auto": false,
      "display_name": "...",
      "distribution_name": "...",
      "distribution_version": "...",
      "distribution_source": "...",
      "has_alias": true
    }
  ]
}
```

This payload includes host paths and operational metadata; it is an admin catalog, not
a browser-public discovery document.

### `POST /api/profiles`

Released `ProfileCreate` accepts:

```json
{
  "name": "researcher",
  "clone_from": null,
  "clone_from_default": false,
  "clone_all": false,
  "no_skills": false,
  "description": "...",
  "provider": null,
  "model": null,
  "mcp_servers": [],
  "keep_skills": [],
  "hub_skills": []
}
```

With all clone fields false/null it performs a fresh create. Optional model/MCP/Skill
post-configuration is explicitly best-effort after the directory exists; callers must
inspect `model_set`, `mcp_written`, `skills_disabled`, and `hub_installs` rather than
assuming an HTTP success means all post-steps completed. The response also exposes the
created absolute path and asynchronous hub-install PIDs.

Evidence: [`ProfileCreate` model](https://github.com/NousResearch/hermes-agent/blob/v2026.8.31/hermes_cli/web_models.py),
[profile Dashboard routes](https://github.com/NousResearch/hermes-agent/blob/v2026.8.31/hermes_cli/web_routers/profiles.py), and
[profile response projection](https://github.com/NousResearch/hermes-agent/blob/v2026.8.31/hermes_cli/web_server.py).
Confidence: high.

### Authentication and CORS limit

- Loopback Dashboard binding has no login gate. Any process able to reach that local
  port can invoke its administrative API, so keep it loopback-only or isolate it.
- Any non-loopback bind, or a non-loopback `dashboard.public_url`, engages auth and
  fails closed at startup unless username/password, OAuth/OIDC, or a custom provider is
  configured. Username/password is documented only for a trusted LAN/VPN; OAuth/OIDC
  is the public-network path.
- Protected `/api/*` routes require a verified Dashboard session cookie. The generic
  bearer seam applies only to exact paths explicitly registered by a token auth
  provider. The bundled drain provider registers only `/api/gateway/drain`; it does not
  authorize `/api/profiles` or `/api/env`.
- Dashboard CORS is restricted to its configured localhost development/production
  origins. AOS should not call it directly from an arbitrary browser origin.

This finding is superseded for the implemented baseline. AOS uses the native
authenticated `hermes serve` gateway directly, including `profiles.list`, and keeps no
configured profile registry. The browser follows native login and uses the same-site
session plus single-use WebSocket tickets; it never reuses `API_SERVER_KEY` as Dashboard
authentication.

Evidence: [Web Dashboard guide](https://github.com/NousResearch/hermes-agent/blob/v2026.8.31/website/docs/user-guide/features/web-dashboard.md),
[`token_auth.py` exact-route seam](https://github.com/NousResearch/hermes-agent/blob/v2026.8.31/hermes_cli/dashboard_auth/token_auth.py), and
[Dashboard middleware](https://github.com/NousResearch/hermes-agent/blob/v2026.8.31/hermes_cli/web_server.py).
Confidence: high.

## Released Session history, continue, and fork behavior

All routes in this section are API Server routes at the profile base URL. Defaults are
`127.0.0.1:8642` and bearer `API_SERVER_KEY`; the key is mandatory even on loopback.
With `gateway.multiplex_profiles: true`, a single default-profile listener serves
`/p/<profile>/...`, but each prefix authenticates with that target profile's distinct
key. The API server has no machine-wide profile-list endpoint.

Clients must first probe `GET /p/{profile}/v1/capabilities` and use its advertised
`endpoints`/feature flags. At this tag it advertises Session CRUD/messages/fork/chat,
Runs/status/events/approval/steer/stop, Skills, Toolsets, and model options.

### History and discovery

- `GET /api/sessions?limit=50&offset=0&source=<source>&include_children=false`
  lists persisted profile Sessions by recent activity. `limit` defaults to 50 and is
  capped at 200. Hidden, archived, and child Sessions are omitted by default; pinned
  Sessions can be backfilled beyond the nominal limit.
- `GET /api/sessions/{id}` returns client-safe metadata.
- `GET /api/sessions/{id}/messages?limit=<0..500>&offset=<n>&order=oldest|latest`
  returns projected messages. With no `limit`, it defaults to the latest 500. The
  handler first resolves Hermes' resumable/compaction descendant ID, so the returned
  `session_id` may differ from the requested one.

This reads the shared profile `state.db`, so it can discover persisted CLI, cron,
gateway/channel, Dashboard, and API Sessions. It does not prove that an external
process still owns a live turn, and it does not attach that turn to an API Run.

### Create and continue

`POST /api/sessions` creates an empty durable Session. Accepted fields include
`id`/`session_id`, `title`, `source`, `system_prompt`, and runtime model/provider
options. Creation is atomic and returns 201; duplicate IDs return 409. It does not
accept initial messages.

`POST /v1/runs` is the preferred detachable continuation path:

```json
{
  "session_id": "aos_opaque_id",
  "input": "the next user turn",
  "instructions": "optional turn-scoped overlay",
  "conversation_history": [
    { "role": "user", "content": "optional model-only context" }
  ]
}
```

It returns 202 with `run_id`; use a deterministic `Idempotency-Key` (1-255 visible
ASCII characters). When no explicit `conversation_history` or
`previous_response_id` is supplied, Hermes loads the durable history for
`session_id`. Run status and control are then keyed by `run_id`:

- `GET /v1/runs/{run_id}`
- `GET /v1/runs/{run_id}/events` (SSE)
- `POST /v1/runs/{run_id}/approval`
- `POST /v1/runs/{run_id}/steer`
- `POST /v1/runs/{run_id}/stop`

There is no `/continue` endpoint and no released list-runs-by-session endpoint. AOS
must retain `run_id`. `POST /api/sessions/{id}/chat` and `/chat/stream` also continue a
Session, but the first blocks until one turn completes and the SSE variant is tied to
that request; `/v1/runs` is the stronger reconnectable AOS contract.

Explicit `conversation_history` is accepted as model context, but the agent marks
caller-provided history as already durable and does not append those supplied rows to
the target Session. Only the new turn persists. Therefore it is not a durable Session
import operation.

Evidence: [API Server guide](https://github.com/NousResearch/hermes-agent/blob/v2026.8.31/website/docs/user-guide/features/api-server.md),
[`api_server_runs.py`](https://github.com/NousResearch/hermes-agent/blob/v2026.8.31/gateway/platforms/api_server_runs.py),
[`api_server.py` Session handlers](https://github.com/NousResearch/hermes-agent/blob/v2026.8.31/gateway/platforms/api_server.py), and
[`_flush_messages_to_session_db_unlocked`](https://github.com/NousResearch/hermes-agent/blob/v2026.8.31/run_agent.py).
Confidence: high.

### Native fork is destructive to the source's active status

`POST /api/sessions/{source_id}/fork` accepts optional `id`/`session_id` and `title`,
then:

1. rejects a duplicate target with 409;
2. marks the source Session ended with `end_reason="branched"`;
3. creates an `api_server` child with the source `model`, `system_prompt`, and
   `parent_session_id`;
4. copies the complete message transcript;
5. assigns a lineage title and returns the child as 201.

This matches CLI `/branch`; it is not a non-mutating clone. It must not be invoked on
a possibly live externally owned Session merely because the Session appears in
history. Safe uses are a quiescent AOS-owned Session or an explicit user-confirmed
branch after live ownership has been resolved.

For the default externally discovered flow, create a new API Session and persist a
bounded, quoted source snapshot and provenance pointer in its **first user input**,
labelled “Start new Session with this context.” That gives Hermes useful context,
leaves the source untouched, and makes the handoff auditable. A raw
`conversation_history` seed alone is insufficient because it is not persisted.

Evidence: [`_handle_fork_session`](https://github.com/NousResearch/hermes-agent/blob/v2026.8.31/gateway/platforms/api_server.py).
Confidence: high.

## Material limits to preserve in the implementation plan

- The released APIs do not offer global Session-created events, a durable discovery
  cursor, list-runs-by-session, or attach/control of a CLI/cron/channel process's
  current live turn. Polling history and observing an API Run are separate concepts.
- API Run controls apply to Runs owned by that API Server process and identified by a
  retained `run_id`; a Session row alone is not a live-control handle.
- Profile distributions do not install the AOS native plugin. Their default owned
  paths exclude `plugins/`; run the separately pinned plugin install per profile.
- A profile is not an OS sandbox. `HERMES_HOME` isolates Hermes data, while host
  credentials under the real `HOME` and inherited environment can remain accessible.
- Dashboard `/api/profiles` is not authenticated by `API_SERVER_KEY` and should not be
  required for ordinary adapter operation.
- Hermes issue [#501](https://github.com/NousResearch/hermes-agent/issues/501) proposed
  a Web UI and listed AG-UI compatibility as a later-phase idea; it is design history,
  not evidence of a released native AG-UI transport. The released integration surface
  above is Dashboard REST plus the API Server and native plugin APIs.

## Provenance summary

| Supported claim                                                          | Direct evidence                                                                               | Confidence / contradiction                                           |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Tag identity is v0.21.0 at commit `29112bef...`                          | [Release v2026.8.31](https://github.com/NousResearch/hermes-agent/releases/tag/v2026.8.31)    | High                                                                 |
| Native plugin can register model tools and prompt sections               | `PluginContext.register_tool`, `register_system_prompt_section`; official plugin/hooks guides | High                                                                 |
| Plugin pinning is an exact immutable SHA                                 | `hermes plugins install --ref`; plugin user guide                                             | High                                                                 |
| Monorepo subdirectory and local Git installs are supported               | `_resolve_git_url` accepts repo subdirs and `file://`; installer still clones Git             | High; a plain directory/archive is not accepted by `plugins install` |
| Ordinary tool handler receives Session/task context but not tool-call ID | `model_tools.handle_function_call` registry dispatch                                          | High; correlate returned `start_request_id` at the AOS event adapter |
| Manifest v2 cannot be safely installed at this pin                       | developer guide describes v2; installer max is 1                                              | High; upstream documentation/code contradiction                      |
| Fresh profile creation avoids copying `.env`; clone copies it            | `create_profile`; profiles guide                                                              | High                                                                 |
| Distribution install strips credentials/user data                        | `USER_OWNED_EXCLUDE`, `_copy_dist_payload`; distribution guide                                | High                                                                 |
| Distribution ref pin is not implemented                                  | parser has no `--ref`; `_git_clone` clones depth-one URL as-is                                | High; contradicts module docstring's `#<ref>` statement              |
| Dashboard lists/creates profiles                                         | `GET/POST /api/profiles`, `ProfileCreate`                                                     | High                                                                 |
| Dashboard has no general bearer for those routes                         | exact-path token-auth seam; bundled drain only opts in drain                                  | High                                                                 |
| API Server can create/continue/observe/control durable API Sessions      | capabilities and Session/Run handlers                                                         | High                                                                 |
| Explicit Run history is not a durable import                             | Run parser plus SessionDB flush identity-skip                                                 | High                                                                 |
| Native fork ends the source as branched                                  | `_handle_fork_session`                                                                        | High; surprising/destructive semantic                                |
