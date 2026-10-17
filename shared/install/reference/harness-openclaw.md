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

The harness-gw gateway turns the server on for each Session it runs, which requires the
gateway's device to hold `operator.admin`. Charts, maps, and stats are MCP App
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

For `aos-invite-link`, set `AOS_GATEWAY_URL` to the operator gateway
origin in the Gateway's environment.

## No creator

AOS offers no **New Agent** on OpenClaw, so install no creator. An
`aos-agent-creator` Agent installed earlier shows as an ordinary Agent.
