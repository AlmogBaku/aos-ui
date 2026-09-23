# Install AOS UI into OpenClaw

OpenClaw keeps its configuration in a strict `openclaw.json`: one unknown key
stops the Gateway. Change it only through `openclaw` commands, and run
`openclaw config validate` after every change. List Agents with
`openclaw agents list --json`.

## Register the tools MCP server

Register it once, disabled, so it loads only in Sessions AOS enables it for:

```bash
openclaw mcp add aos-ui --url http://127.0.0.1:4110/mcp \
  --transport streamable-http --disabled
openclaw config validate
openclaw mcp show aos-ui --json
```

The AOS proxy turns the server on for each Session it runs, which requires the
proxy's device to hold `operator.admin`. Charts, maps, and stats are MCP App
views, which the Gateway serves only with MCP Apps on; with the operator's
go-ahead, run `openclaw config set mcp.apps.enabled true` and
`openclaw config validate`. The Gateway picks up the new server
after the operator restarts it.

## Install the skills

OpenClaw loads a workspace skill only when its real path stays inside the
workspace, so copy each skill directory into each named Agent's workspace:

```bash
mkdir -p <workspace>/skills
cp -R <checkout>/shared/invite-link <workspace>/skills/aos-invite-link
openclaw skills list --agent <agent> --json
```

For `aos-invite-link`, set `AOS_RUNTIME_PROXY_URL` to the operator proxy
origin in the Gateway's environment.

## Install the creator (only if asked)

AOS recognizes the creator by its reserved id, `aos-agent-creator`:

```bash
openclaw agents list --json               # aos-agent-creator must be free
openclaw agents add aos-agent-creator \
  --workspace ~/.openclaw/workspace-aos-agent-creator --non-interactive
mkdir -p ~/.openclaw/workspace-aos-agent-creator/skills
cp -R <checkout>/shared/agent-creator \
  ~/.openclaw/workspace-aos-agent-creator/skills/aos-agent-creator
```

Write "You are AOS's Agent creator. Load and follow the aos-agent-creator
skill." to the workspace's `SOUL.md`, and `Agent Creator` as the name in its
`IDENTITY.md`, then run
`openclaw agents set-identity --agent aos-agent-creator --from-identity`.

The creator writes Agents through the `openclaw` CLI, so it needs OpenClaw's
command execution tool. Verify with `openclaw agents list --json` and
`openclaw skills list --agent aos-agent-creator --json`. AOS hides the creator
from the roster and offers it as **New Agent**.
