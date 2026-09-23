# Install AOS UI into OpenCode

OpenCode serves one worktree. Its Agents are Markdown files in
`.opencode/agents/`, and its configuration is `opencode.json` in the worktree.

## With the AOS launcher

From the checkout, start the tools MCP server, then the launcher:

```bash
bun run tools-mcp:serve
AOS_UI_OPENCODE_WORKTREE=/absolute/path/to/worktree bun run opencode:serve
```

The launcher registers `aos-ui` for every Session and installs the hidden
`agent-builder` creator with the `aos-agent-creator` and `aos-invite-link`
skills. It refuses to start rather than overwrite a conflicting file. Set
`AOS_UI_TOOLS_MCP_URL` when the server is not on the default URL.

## With an independently launched server

Add this entry to the worktree's `opencode.json`, keeping every other key:

```json
{
  "mcp": {
    "aos-ui": {
      "type": "remote",
      "url": "http://127.0.0.1:4110/mcp",
      "enabled": true
    }
  }
}
```

Copy each skill directory into `.opencode/skills/`, for example
`cp -R <checkout>/shared/invite-link .opencode/skills/aos-invite-link`. Leave
the creator to the launcher, which writes its fixed definition.

OpenCode reads configuration at start-up, so the operator restarts the server
afterwards. The pinned OpenCode session engine does not yet expose MCP tools,
so the `aos-ui` tools are registered but not callable through AOS on OpenCode.
When they are, the AOS proxy reads their chart, map, and stats views from the
registered URL, so it must be one the proxy can reach too.
