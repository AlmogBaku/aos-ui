# AOS Hermes integration package

This directory packages optional native AOS tools for an independently installed Hermes runtime. It does not install or start Hermes. For browser attachment, server authentication, Compose, and runtime operations, follow the canonical [Hermes operator guide](../../docs/runtimes/hermes.md).

Hermes owns profiles, Sessions, messages, runs, and durable state. This package
adds presentation tools, Session handoff, creator guidance, and the read-only
`aos-integration:aos-invite-link` skill; it contains no AOS bridge, registry,
or conversation database.

## Install the plugin

Install from an immutable AOS commit into each participating profile:

```bash
hermes -p PROFILE plugins install OWNER/REPOSITORY/integrations/hermes \
  --ref FULL_40_CHARACTER_COMMIT_SHA --no-enable
hermes -p PROFILE plugins doctor aos-integration --ci
hermes -p PROFILE plugins enable aos-integration
hermes -p PROFILE tools enable --platform api_server aos-presentation aos-session-handoff
hermes -p PROFILE tools enable --platform cli aos-presentation aos-session-handoff
```

For creator profiles, also enable the `aos` toolset to expose `aos_create_agent`:

```bash
hermes -p PROFILE tools enable --platform api_server aos
hermes -p PROFILE tools enable --platform cli aos
```

For a committed local checkout, use `file:///absolute/path/to/aos-ui#integrations/hermes` as the source.

Enable both platforms. `api_server` serves browser and gateway runs; `cli` is required by `aos_start_session`. The plugin registers seven tools: `render_chart`, `render_map`, `render_stats`, `present_plan`, and `present_artifact` (toolset `aos-presentation`; `plugin.py:133-135,175-177`), `aos_start_session` (toolset `aos-session-handoff`; `plugin.py:153-154`), and `aos_create_agent` (toolset `aos`; `plugin.py:239-240`).

`aos_start_session` requires an explicit profile, absolute worktree, and prompt. It invokes Hermes with a fixed argument vector:

```text
hermes -p PROFILE chat --in WORKTREE -c UNIQUE_TITLE --create-if-missing -Q --query-file SECURE_TEMP
```

The prompt file is mode `0600` and deleted after invocation. A timeout or lost subprocess outcome is reported as uncertain and is never retried automatically.

When a user asks for a guest invite, the plugin points Hermes to
`aos-integration:aos-invite-link` through `skill_view`. The skill invokes the
trusted operator proxy's invitation endpoint with `curl`; signing keys remain
inside the proxy. Configure `AOS_RUNTIME_PROXY_URL` for the Hermes service to a
reachable configured operator origin. The skill recommends a dedicated,
narrowly skilled and restricted Agent before signing. The invited Session is
created lazily on first Send. Follow the canonical
[invited-chat guide](../../docs/invite-chat.md).

## Provision the creator

Creator privilege comes only from native profile metadata:

```yaml
ui_meta:
  aos:
    role: creator
  hermes-bots:
    hidden: true
```

Configure these values in that profile when it will install the package for newly proposed Agents:

```text
AOS_HERMES_PLUGIN_SOURCE=OWNER/REPOSITORY/integrations/hermes
AOS_HERMES_PLUGIN_REF=FULL_40_CHARACTER_COMMIT_SHA
```

`aos_create_agent` writes the new Agent in the creator's own Hermes process. It
validates the confirmed proposal, refuses a reserved or already-taken name,
creates the profile, verifies it, then writes in this order: hidden `ui_meta`
into `profile.yaml`, `SOUL.md` from the confirmed instructions, and the display
name and description through the native profile meta writer. It then installs
the configured package ref, enables `aos-integration`, and enables the agreed
toolsets for the `api_server` and `cli` platforms.

The Agent stays hidden until that setup is confirmed by reading the profile's
`config.yaml` back. Only then does the creator clear `hermes-bots.hidden`, so a
half-configured Agent never appears in the roster. Hermes at or after
`a0500081` publishes a profile with one atomic rename, so a concurrent creator
can no longer observe or adopt a half-written profile directory.

A `setup-needed` result means the profile exists and is still hidden: one of the
package or toolset steps failed or timed out. A `setup-needed` result with
`"error": "Profile creation failed"` specifically means the profile was created
but one of its metadata writes (ui_meta, SOUL.md, or display name) failed;
inspect it with `hermes profile list` and the profile directory, then finish
with the commands below. Finish it from a shell, then make
the Agent visible in **Manage Agents**:

```bash
hermes -p <name> plugins install <source> --ref <sha> --no-enable
hermes -p <name> plugins enable aos-integration --no-allow-tool-override
hermes -p <name> tools enable --platform api_server aos-presentation aos-session-handoff
hermes -p <name> tools enable --platform cli aos-presentation aos-session-handoff
```

The creator's model block is copied into every created profile, so any gateway
authentication header under the creator profile's
`providers.<name>.extra_headers` must use a `${VAR}` placeholder rather than a
literal secret; creation is refused when that block carries an inline
credential.

`integrations/hermes/scripts/provision-creator.sh` provisions a creator profile
with these values.

## Optional Monty

Configure Monty through native Hermes MCP settings for profiles that need it. This package neither starts Monty nor depends on it.

## Verify the package

```bash
bun run integrations:build
uv sync --project integrations/hermes --frozen
bun run hermes:test
uv build integrations/hermes --out-dir integrations/hermes/dist --clear
```
