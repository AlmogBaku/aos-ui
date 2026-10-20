# Install AOS UI into Hermes

A Hermes Agent is a profile. The default profile lives in `~/.hermes`; every
other profile lives in `~/.hermes/profiles/<profile>/`. Pass `-p <profile>` to
act on a named profile. List them first with `hermes profile list`.

## Register the tools MCP server

A profile never inherits MCP servers from the default profile, so register
the server on the default profile and on every profile a person talks to
through AOS, including the Agent creator and any guest-facing Agent. An Agent
without it has no `present_artifact` and falls back to attachments AOS cannot
preview. Ask the operator which profiles are user-facing; a background Agent
does not need it. For each of those profiles:

```bash
hermes -p <profile> config set mcp_servers.aos-ui.url http://127.0.0.1:4110/mcp
hermes -p <profile> mcp test aos-ui
```

`hermes mcp add` is interactive, so prefer `config set`. The tools reach the
model as `mcp__aos_ui__render_chart` and so on. The harness-gw gateway reads the chart,
map, and stats views from the same URL, so it must be one the gateway can reach
too; ask the operator when the gateway runs in a container. In a Session that is already
open, `/reload-mcp` picks them up; a new Session loads them on its own.

A profile created later needs the same commands. The Agent creator runs them
for every Agent it builds; anything else that creates a user-facing profile
must run them too.

## Set the AOS note

Hermes runs every AOS Session as the `aos-ui` platform, including a Session a
schedule, the terminal, or a messaging channel began and the person continues
in AOS. That platform has no note of its own, so without one the model keeps
the rules it started with: plain text, and files as bare paths. Set the note in
every profile, the default one included, with or without the tools:

```bash
hermes -p <profile> config set platform_hints.aos-ui.append \
  "You are chatting in AOS UI, a web chat. Markdown renders with GitHub flavor: headings, tables, task lists, highlighted code, and mermaid diagrams. Show every file you deliver with the mcp__aos_ui__present_artifact tool, directly or through tool_call, when it is available; otherwise write MEDIA:/absolute/path on its own line. Never deliver a file as a bare path or a ::preview{...} directive; AOS shows neither."
hermes -p <profile> config get platform_hints.aos-ui.append
```

The last command must print the note back. A profile created later needs it
too; the Agent creator copies its own to every Agent it builds.

## Install the skills

Link each skill directory into the profile's `skills/` directory (Hermes
follows the link; do not copy):

```bash
ln -s <checkout>/shared/invite-link <profile-home>/skills/aos-invite-link
```

`<profile-home>` is `~/.hermes` for the default profile. For
`aos-invite-link`, set `AOS_GATEWAY_URL` to the operator gateway origin in
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

Set the [AOS note](#set-the-aos-note) on `aos-agent-creator` as well: the
creator copies its own note to every Agent it builds.

Never pass `--clone`, `--clone-all`, or `--clone-from`. Replace the seeded
`~/.hermes/profiles/aos-agent-creator/SOUL.md` with: "You are AOS's Agent
creator. Load and follow the aos-agent-creator skill. Never introduce yourself
or mention slash commands." Discarded interviews leave the creator with no
earlier Sessions, so Hermes treats each one as a first contact and asks for an
introduction that mentions `/help`; the last sentence declines it.

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

Every key in `ui_meta.aos` reaches the operator's browser, so never put a path,
token, or other private value there.

When the operator's household runs the aos capability kit, the creator builds
through its `capability-build` skill, which the kit installs only into the
default profile. Give the creator the kit's build path too: link
`capability-lifecycle`, `capability-build`, `capability-install`,
`capability-onboard`, and `skill-creator` into its `skills/`, record the links
under the `capability-lifecycle` entry with `aos-cap record`, and add a
household rule naming the creator to the root `MOD.md` through
`capability-evolve`, so the kit's upgrade keeps the links. Without the kit,
skip this: the creator builds with the `hermes` CLI alone.

The creator writes Agents through the `hermes` CLI, so its profile must keep
Hermes's terminal tool. A new profile has no model credentials of its own:
the operator signs it in with `hermes -p aos-agent-creator auth add`. Never
copy another profile's tokens.

Verify with `hermes profile show aos-agent-creator` and
`hermes -p aos-agent-creator skills list`. AOS hides the creator from the
roster and offers it as **New Agent**.
