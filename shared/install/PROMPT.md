# Install AOS UI into a harness

You are installing AOS UI's integration into one independently operated agent
harness: Hermes, OpenClaw, or OpenCode. AOS UI adds no runtime of its own. The
harness keeps its Agents, Sessions, credentials, and state; this installation
only registers the `aos-ui` tools MCP server and installs AOS UI's skills.

Before you change anything, establish with the operator:

- which harness to configure, and which of its Agents should get the tools;
- where this AOS UI checkout lives (its `shared/` directory holds the skills);
- the tools MCP URL the harness can reach (default
  `http://127.0.0.1:4110/mcp`); on Hermes and OpenCode the AOS proxy must
  reach it too, because it reads the chart, map, and stats views itself;
- whether to install the hidden Agent creator behind AOS's **New Agent**;
- the operator proxy origin, if Agents should issue guest invitations.

Then:

1. Make sure the tools MCP server is running and healthy. From the checkout,
   `bun run tools-mcp:serve` serves it on loopback port `4110`, or the Compose
   stack runs it as the `tools-mcp` service. Check it with
   `curl --fail --silent <origin>/health`.
2. Follow `reference/harness-<harness>.md` beside this prompt (`hermes`,
   `openclaw`, or `opencode`) to register the server, install the skills, and,
   if asked, install the creator.
3. Verify each step with the harness's own read-only commands, as the reference
   describes.
4. Report exactly what you changed, what you verified, and every step left to
   the operator, such as a restart.

Rules:

- Use the harness's own CLI. Hand-edit a file only where the reference says no
  command exists, and then change only the named keys.
- Touch only the Agents the operator named. Never rename, delete, or re-create
  an existing Agent, and never overwrite a file or skill that already exists
  with different content; stop and ask instead.
- Never read, copy, print, or move credentials. The tools MCP server needs
  none, and no secret belongs in a skill, a prompt, or an Agent's instructions.
- Restart a harness process only with the operator's go-ahead, once its active
  work has finished.
