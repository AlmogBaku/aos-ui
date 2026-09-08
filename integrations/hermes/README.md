# AOS Hermes integration

This directory packages native Hermes tools for AOS. The browser integration was
tested against checkout `b29b352c9eeec261fc17b09bd5402b5a8a0c4a8b`; the required
RPC surface was also verified in the unmodified `v2026.9.7` release. Hermes owns
profiles, Sessions, messages, runs, and every durable record; this package contains
no AOS bridge, profile registry, correlation database, or conversation store.

## Install the plugin

Install from an immutable AOS commit into each participating native profile:

```bash
hermes -p PROFILE plugins install OWNER/REPOSITORY/integrations/hermes \
  --ref FULL_40_CHARACTER_COMMIT_SHA --no-enable
hermes -p PROFILE plugins doctor aos-integration --ci
hermes -p PROFILE plugins enable aos-integration
hermes -p PROFILE tools enable --platform api_server aos-presentation aos-session-handoff
hermes -p PROFILE tools enable --platform cli aos-presentation aos-session-handoff
```

For a committed local checkout, use
`file:///absolute/path/to/aos-ui#integrations/hermes` as the source. The released
legacy-v1 plugin registers `render_chart`, `render_map`, `render_stats`,
`present_plan`, and `aos_start_session`, plus browser-independent prompt guidance.
The generated presentation catalog and creator guidance are included in the wheel.
Enable both surfaces as shown above: `api_server` serves gateway/browser runs,
while `cli` is used by `aos_start_session`; configuring only one surface does
not enable these tools on the other.

When Hermes is mounted at `/hermes`, keep the supplied Nginx/Vite `/auth`
forwarding enabled. The verified native login page submits to that absolute path;
authentication, cookies, and credential validation still remain entirely native.

`aos_start_session` requires an explicit profile, absolute worktree, and prompt.
It invokes Hermes directly with a fixed argument vector:

```text
hermes -p PROFILE chat --in WORKTREE -c UNIQUE_TITLE --create-if-missing -Q --query-file SECURE_TEMP
```

The prompt file is mode `0600` and deleted after the invocation. The tool reports the
actual native Session ID emitted by `-Q` on stderr. A timeout or lost subprocess
outcome is reported as uncertain and is never retried automatically.

## Provision the creator

Creator privilege is native profile metadata, provisioned explicitly by an operator.
Set both keys in the dedicated creator profile's `profile.yaml` before starting it:

```yaml
ui_meta:
  aos:
    role: creator
  hermes-bots:
    hidden: true
```

The plugin only reads this metadata; it never grants itself creator authority or
writes metadata to an existing profile. Configure these profile-scoped values for the
creator:

```text
AOS_HERMES_PLUGIN_SOURCE=OWNER/REPOSITORY/integrations/hermes
AOS_HERMES_PLUGIN_REF=FULL_40_CHARACTER_COMMIT_SHA
```

`aos_create_agent` currently validates the confirmed proposal and then fails closed
without invoking Hermes or writing any profile. In the unmodified
[`v2026.9.7` release](https://github.com/NousResearch/hermes-agent/blob/2237be355906fbe6065ce1815711eee52b2d646e/hermes_cli/profiles.py#L794-L847),
`hermes_cli/profiles.py` checks whether the profile exists and then bootstraps it with
`mkdir(parents=True, exist_ok=True)`. The gateway dispatches profile creation through
a worker pool. A disposable two-writer test reproduced both concurrent calls
reporting success against the same profile. Hermes therefore has no public atomic,
no-overwrite profile-create operation at this release or current `main`.
The closest upstream attempt, [PR #76029](https://github.com/NousResearch/hermes-agent/pull/76029),
was closed unmerged after review identified the same missing atomic no-replace
guarantee; the native rename and import paths have equivalent check-then-move races.

Automated creation remains blocked until upstream exposes such an operation. This is
an acceptance blocker, not `setup-needed` success: the tool returns an explicit error
and performs zero native writes. The creator interview and confirmation guidance is
retained so the workflow can be enabled once that prerequisite exists. Creation must
then use a fresh non-cloning profile, avoid copying credentials, write only inside the
new profile, enable selected tools for both `api_server` and `cli`, and report
`setup-needed` until credentials and a model are independently verified.

## Optional Monty

Monty is optional. Configure it through Hermes' native MCP configuration in profiles
that need it. This plugin neither starts Monty nor depends on it.

## Verify

```bash
bun run integrations:build
uv sync --project integrations/hermes --frozen
bun run hermes:test
uv build integrations/hermes --out-dir integrations/hermes/dist --clear
```
