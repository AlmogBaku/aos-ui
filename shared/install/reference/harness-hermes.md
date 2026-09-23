# Install AOS UI into Hermes

A Hermes Agent is a profile. The default profile lives in `~/.hermes`; every
other profile lives in `~/.hermes/profiles/<profile>/`. Pass `-p <profile>` to
act on a named profile. List them first with `hermes profile list`.

## Register the tools MCP server

For each named profile:

```bash
hermes -p <profile> config set mcp_servers.aos-ui.url http://127.0.0.1:4110/mcp
hermes -p <profile> mcp test aos-ui
```

`hermes mcp add` is interactive, so prefer `config set`. The tools reach the
model as `mcp__aos_ui__render_chart` and so on. The AOS proxy reads the chart,
map, and stats views from the same URL, so it must be one the proxy can reach
too; ask the operator when the proxy runs in a container. In a Session that is already
open, `/reload-mcp` picks them up; a new Session loads them on its own.

## Install the skills

Link each skill directory into the profile's `skills/` directory (Hermes
follows the link; do not copy):

```bash
ln -s <checkout>/shared/invite-link <profile-home>/skills/aos-invite-link
```

`<profile-home>` is `~/.hermes` for the default profile. For
`aos-invite-link`, set `AOS_RUNTIME_PROXY_URL` to the operator proxy origin in
the profile's environment. A running `hermes serve` caches the skills index:
ask the operator to restart it, then check with
`hermes -p <profile> skills list`.

## Install the creator (only if asked)

```bash
hermes profile list                       # aos-agent-creator must be free
hermes profile create aos-agent-creator --no-alias \
  --description "Creates AOS Agents through a guided interview"
ln -s <checkout>/shared/agent-creator \
  ~/.hermes/profiles/aos-agent-creator/skills/aos-agent-creator
hermes -p aos-agent-creator config set mcp_servers.aos-ui.url http://127.0.0.1:4110/mcp
```

Never pass `--clone`, `--clone-all`, or `--clone-from`. Replace the seeded
`~/.hermes/profiles/aos-agent-creator/SOUL.md` with: "You are AOS's Agent
creator. Load and follow the aos-agent-creator skill."

No command marks a profile as the creator. Add these keys to
`~/.hermes/profiles/aos-agent-creator/profile.yaml` (not `config.yaml`),
keeping every key already there:

```yaml
ui_meta:
  aos:
    role: creator
  hermes-bots:
    hidden: true
_ui_meta_revisions:
  aos: 1
  hermes-bots: 1
```

The creator writes Agents through the `hermes` CLI, so its profile must keep
Hermes's terminal tool. A new profile has no model credentials of its own:
the operator signs it in with `hermes -p aos-agent-creator auth add`. Never
copy another profile's tokens.

Verify with `hermes profile show aos-agent-creator` and
`hermes -p aos-agent-creator skills list`. AOS hides the creator from the
roster and offers it as **New Agent**.
