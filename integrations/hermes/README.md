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

For a committed local checkout, use `file:///absolute/path/to/aos-ui#integrations/hermes` as the source.

Enable both platforms. `api_server` serves browser and gateway runs; `cli` is required by `aos_start_session`. The released legacy-v1 plugin registers `render_chart`, `render_map`, `render_stats`, `present_plan`, and `aos_start_session`, plus browser-independent presentation guidance.

`aos_start_session` requires an explicit profile, absolute worktree, and prompt. It invokes Hermes with a fixed argument vector:

```text
hermes -p PROFILE chat --in WORKTREE -c UNIQUE_TITLE --create-if-missing -Q --query-file SECURE_TEMP
```

The prompt file is mode `0600` and deleted after invocation. A timeout or lost subprocess outcome is reported as uncertain and is never retried automatically.

When a user asks for a guest invite, the plugin points Hermes to
`aos-integration:aos-invite-link` through `skill_view`. The skill requires an
exact target profile, verifies it with `hermes profile show`, and invokes the
stateless `aos-gateway` binary. Install that binary on the Hermes process
`PATH`, provision `AOS_GATEWAY_INVITE_SIGNING_KEY` in the same environment, and
follow the canonical [invited-chat guide](../../docs/invite-chat.md).

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

`aos_create_agent` currently validates a confirmed proposal and then fails closed without writing a profile. The verified Hermes releases create profiles through a check-then-mkdir path rather than an atomic no-overwrite operation, so concurrent creators could target the same name. Until Hermes exposes a safe primitive, this result is an acceptance blocker rather than `setup-needed` success.

## Optional Monty

Configure Monty through native Hermes MCP settings for profiles that need it. This package neither starts Monty nor depends on it.

## Verify the package

```bash
bun run integrations:build
uv sync --project integrations/hermes --frozen
bun run hermes:test
uv build integrations/hermes --out-dir integrations/hermes/dist --clear
```
